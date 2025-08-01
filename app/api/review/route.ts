import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getServerSession } from 'next-auth';
import { opts } from '../auth/[...nextauth]/route';
import { getProjectHackatimeHours, getProjectApprovedHours } from '@/lib/project-client';

// GET all projects that are in review (from all users)
export async function GET() {
  console.log('🔍 /api/review endpoint called');
  
  try {
    // Check for valid session - user must be logged in but doesn't need to be the project owner
    const session = await getServerSession(opts);
    if (!session?.user) {
      console.log('❌ No session found');
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if the user is an admin or reviewer
    const isAdmin = session.user.role === 'Admin' || session.user.isAdmin === true;
    const isReviewer = session.user.role === 'Reviewer';

    if (!isAdmin && !isReviewer) {
      console.log('❌ User is not admin or reviewer');
      return NextResponse.json({ error: 'Forbidden: Requires Admin or Reviewer role' }, { status: 403 });
    }

    console.log('✅ User authenticated as admin/reviewer');
    console.log('Fetching projects in review...');

    // Fetch all projects that have in_review=true
    // Fixed the query to avoid using both include and select for the same relation
    const projectsInReview = await prisma.project.findMany({
      where: {
        in_review: true,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            hackatimeId: true,
            status: true,
          }
        },
        reviews: {
          include: {
            reviewer: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              }
            }
          },
          orderBy: {
            createdAt: 'desc',
          },
        },
        hackatimeLinks: true,
        projectTags: {
          include: {
            tag: true,
          },
        },
      },
    });

    console.log(`Found ${projectsInReview.length} projects in review`);
    
    if (projectsInReview.length > 0) {
      console.log('Projects in review:');
      projectsInReview.forEach((project, index) => {
        console.log(`  ${index + 1}. ${project.name} (by ${project.user?.name}) - User ID: ${project.userId}`);
      });
    } else {
      console.log('⚠️  No projects are currently in review');
    }

    // Get unique user IDs to fetch their approved hours
    const userIds = [...new Set(projectsInReview.map((project: any) => project.userId))];
    console.log(`Unique users with projects in review: ${userIds.length}`);
    console.log(`User IDs: ${userIds.join(', ')}`);

    // Fetch all projects for these users to calculate their approved hours
    const userProjectsMap: Record<string, number> = {};

    if (userIds.length === 0) {
      console.log('⚠️  No users have projects in review - skipping hour calculations');
      return NextResponse.json([]);
    }

    for (const userId of userIds) {
      try {
        const userProjects = await prisma.project.findMany({
          where: { userId },
          include: { hackatimeLinks: true }
        });

        // Calculate approved hours using the same logic as project-client.ts
        let userApprovedHours = 0;
        const projectsWithHours = userProjects
          .map(project => {
            // Use the same getProjectHackatimeHours logic as progress bar
            const hours = getProjectHackatimeHours(project);
            return { project, hours };
          })
          .sort((a, b) => b.hours - a.hours)
          .slice(0, 4); // Top 4 projects only

        projectsWithHours.forEach(({ project }) => {
          // Use the same getProjectApprovedHours logic as progress bar
          const projectApprovedHours = getProjectApprovedHours(project);

          let contributedHours = 0;

          if (project.viral === true && projectApprovedHours > 0) {
            // Cap contribution at 15 for viral projects with approved hours
            contributedHours = Math.min(projectApprovedHours, 15);
            userApprovedHours += contributedHours;
          } else if (project.shipped === true && projectApprovedHours > 0) {
            // Cap contribution at 15 for shipped projects with approved hours
            contributedHours = Math.min(projectApprovedHours, 15);
            userApprovedHours += contributedHours;
          } else if (!project.shipped && !project.viral) {
            // For unshipped projects, only count if they have approved hours
            if (projectApprovedHours > 0) {
              // Has approved hours - cap at 15
              contributedHours = Math.min(projectApprovedHours, 15);
              userApprovedHours += contributedHours;
            } else {
              // No approved hours - NO CONTRIBUTION
              contributedHours = 0;
            }
          }
        });

        const finalHours = Math.min(userApprovedHours, 60);

        userProjectsMap[userId] = finalHours;
      } catch (error) {
        console.error(`Error calculating approved hours for user ${userId}:`, error);
        userProjectsMap[userId] = 0;
      }
    }

    // Format the response to include user's name and the latest review if any
    const formattedProjects = (projectsInReview || []).map((project: any) => {
      const latestReview = project.reviews.length > 0 ? project.reviews[0] : null;

      // Calculate raw hours from hackatime links
      const rawHours = project.hackatimeLinks.reduce(
        (sum: number, link: any) => sum + (typeof link.rawHours === 'number' ? link.rawHours : 0),
        0
      );

      return {
        ...project,
        userName: project.user?.name || null,
        userEmail: project.user?.email || null,
        userImage: project.user?.image || null,
        userHackatimeId: project.user?.hackatimeId || null,
        latestReview,
        reviewCount: project.reviews?.filter((review: { reviewerId: string }) => review.reviewerId === project.userId).length || 0,
        rawHours: rawHours,
        ownerApprovedHours: userProjectsMap[project.userId] || 0,
      };
    });

    // Sort projects by latest review creation date (oldest first - earliest submitted for review)
    // Projects without reviews will be sorted to the end
    const sortedProjects = formattedProjects.sort((a, b) => {
      const aReviewDate = a.latestReview?.createdAt;
      const bReviewDate = b.latestReview?.createdAt;
      
      // If neither has reviews, maintain original order
      if (!aReviewDate && !bReviewDate) return 0;
      
      // Projects without reviews go to the end
      if (!aReviewDate) return 1;
      if (!bReviewDate) return -1;
      
      // Sort by date (oldest first)
      return new Date(aReviewDate).getTime() - new Date(bReviewDate).getTime();
    });

    return NextResponse.json(sortedProjects);
  } catch (error) {
    console.error('Error fetching projects in review:', error);
    return NextResponse.json(
      { error: 'Failed to fetch projects in review', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
} 