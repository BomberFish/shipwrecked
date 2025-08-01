import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireUserSession } from "@/lib/requireUserSession";
import metrics from "@/metrics";
import { logProjectEvent, AuditLogEventType } from '@/lib/auditLogger';
// Import directly from the root lib with a more explicit path
import * as projectLib from '../../../lib/project';

export type Project = {
    projectID: string
    name: string
    description: string
    codeUrl: string
    playableUrl: string
    screenshot: string
    submitted: boolean
    userId: string
    viral: boolean
    shipped: boolean
    in_review: boolean
    chat_enabled: boolean
}

// Include backward compatibility fields
export type ProjectType = Project & {
    rawHours?: number;
    hoursOverride?: number | null;
    hackatime?: string;
    hackatimeLinks?: {
        id: string;
        hackatimeName: string;
        rawHours: number;
        hoursOverride?: number | null;
    }[];
};

export type ProjectInput = Omit<Project, 'projectID' | 'submitted'>

// Helper functions
async function deleteProject(projectID: string, userId: string) {
    console.log(`[DELETE] Attempting to delete project ${projectID} for user ${userId}`);
    try {
        const result = await prisma.project.delete({
            where: {
                projectID_userId: {
                    projectID,
                    userId
                }
            }
        });
        metrics.increment("success.delete_project", 1);
        console.log(`[DELETE] Successfully deleted project ${projectID}`);
        return result;
    } catch (err) {
        metrics.increment("errors.delete_project", 1);
        console.error(`[DELETE] Failed to delete project ${projectID}:`, err);
        throw err;
    }
}

// API Route handlers
export async function GET(request: Request) { 
    console.log('[GET] Received request to fetch projects');
    try {
        const user = await requireUserSession();
        console.log(`[GET] Authenticated user ${user.id}, fetching their projects`);
        
        // Get projects with their Hackatime links
        const projects = await prisma.project.findMany({
            where: {
                userId: user.id
            },
            include: {
                hackatimeLinks: true
            }
        });
        
        // Enhance the project data with computed properties
        const enhancedProjects = projects.map((project) => {
            // Get the main Hackatime name (for backwards compatibility)
            const hackatimeName = project.hackatimeLinks.length > 0 
                ? project.hackatimeLinks[0].hackatimeName 
                : '';
            
            // Calculate total raw hours from all links, applying individual overrides when available
            const rawHours = project.hackatimeLinks.reduce(
                (sum, link) => {
                    // Use the link's hoursOverride if it exists, otherwise use rawHours
                    const effectiveHours = (link.hoursOverride !== undefined && link.hoursOverride !== null)
                        ? link.hoursOverride
                        : (typeof link.rawHours === 'number' ? link.rawHours : 0);
                    
                    return sum + effectiveHours;
                }, 
                0
            );
            
            console.log(`[GET] Project ${project.projectID} (${project.name}): calculated rawHours = ${rawHours}`);
            
            // Return the enhanced project with additional properties
            return {
                ...project,
                hackatimeName,
                rawHours
            };
        });
        
        console.log(`[GET] Successfully fetched ${projects.length} projects for user ${user.id}`);
        metrics.increment("success.fetch_project", 1);
        return Response.json(enhancedProjects);
    } catch (err) {
        console.error("[GET] Error fetching projects:", err);
        metrics.increment("errors.fetch_project", 1);
        return Response.json({ error: 'Failed to fetch projects' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    console.log('[POST-TRACE] ===== PROJECT CREATION FLOW TRACING =====');
    console.log('[POST-TRACE] 1. Received request to create new project');
    try {
        console.log('[POST-TRACE] 2. About to authenticate user');
        const user = await requireUserSession();
        console.log(`[POST-TRACE] 3. Authentication successful, user ID: ${user.id}`);
        
        // Check if user is admin or reviewer
        const isAdmin = user.role === 'Admin' || user.isAdmin === true;
        const isReviewer = user.role === 'Reviewer';
        const hasPrivilegedAccess = isAdmin || isReviewer;
        
        // Check content type to determine how to parse the request
        const contentType = request.headers.get('content-type');
        console.log('[POST-TRACE] 4. Content-Type:', contentType);

        let projectData;
        console.log('[POST-TRACE] 5. Parsing request data');
        if (contentType?.includes('multipart/form-data')) {
            console.log('[POST-TRACE] 5.1 Parsing as FormData');
            const formData = await request.formData();
            
            // Log each form field received for debugging
            console.log('[POST-TRACE] 5.1.1 Received FormData fields:');
            for (const [key, value] of formData.entries()) {
                // Don't log the entire screenshot if it's a long string
                if (key === 'screenshot' && typeof value === 'string' && value.length > 100) {
                    console.log(`[POST-TRACE] FormData field: ${key} = (screenshot data, length: ${value.length})`);
                } else {
                    console.log(`[POST-TRACE] FormData field: ${key} = ${value}`);
                }
            }
            
            // Explicitly log the hackatime field value
            const hackatimeValue = formData.get('hackatime')?.toString();
            console.log('[POST-TRACE] 5.1.2 Hackatime field value:', hackatimeValue);
            
            projectData = {
                name: formData.get('name')?.toString() || '',
                description: formData.get('description')?.toString() || '',
                hackatimeName: hackatimeValue || '',
                hackatimeProjects: formData.getAll('hackatimeProjects').map(p => p.toString()),
                codeUrl: formData.get('codeUrl')?.toString() || '',
                playableUrl: formData.get('playableUrl')?.toString() || '',
                screenshot: formData.get('screenshot')?.toString() || '',
                chat_enabled: formData.get('chat_enabled') === 'on',
                viral: formData.get('viral') === 'true',
                shipped: formData.get('shipped') === 'true',
                in_review: formData.get('in_review') === 'true',
            };
        } else {
            console.log('[POST-TRACE] 5.2 Parsing as JSON');
            try {
                const rawData = await request.json();
                console.log('[POST-TRACE] 5.2.1 Raw JSON data received:', {
                    ...rawData,
                    screenshot: rawData.screenshot ? `(screenshot data, length: ${rawData.screenshot.length})` : '(none)',
                });
                
                projectData = rawData;
                
                // Ensure required fields are present
                projectData.hackatimeName = projectData.hackatimeName || '';
                projectData.hackatimeProjects = Array.isArray(projectData.hackatimeProjects) 
                  ? projectData.hackatimeProjects 
                  : projectData.hackatimeName ? [projectData.hackatimeName] : [];
                projectData.codeUrl = projectData.codeUrl || '';
                projectData.playableUrl = projectData.playableUrl || '';
                projectData.screenshot = projectData.screenshot || '';
                
            } catch (parseError) {
                console.error('[POST-TRACE] 5.3 Error parsing JSON:', parseError);
                metrics.increment("errors.parse_json", 1);
                return Response.json({ error: 'Failed to parse request JSON' }, { status: 400 });
            }
        }
        
        console.log('[POST-TRACE] 6. Processed project data:', {
            ...projectData,
            screenshot: projectData.screenshot ? `(screenshot data, length: ${projectData.screenshot.length})` : '(none)'
        });

        // Validate required fields
        console.log('[POST-TRACE] 7. Validating required fields');
        if (!projectData.name) {
            console.error('[POST-TRACE] 7.1 Missing required field: name');
            throw new Error('Project name is required');
        }

        if (!projectData.description) {
            console.error('[POST-TRACE] 7.2 Missing required field: description');
            throw new Error('Project description is required');
        }
        
        // Validate Hackatime project names - reject <<LAST_PROJECT>>
        console.log('[POST-TRACE] 7.3 Validating Hackatime project names');
        if (projectData.hackatimeName === '<<LAST_PROJECT>>') {
            console.error('[POST-TRACE] 7.3.1 Rejected attempt to link <<LAST_PROJECT>>');
            throw new Error('The project "<<LAST_PROJECT>>" cannot be linked');
        }
        
        if (projectData.hackatimeProjects && Array.isArray(projectData.hackatimeProjects)) {
            const hasLastProject = projectData.hackatimeProjects.includes('<<LAST_PROJECT>>');
            if (hasLastProject) {
                console.error('[POST-TRACE] 7.3.2 Rejected attempt to link <<LAST_PROJECT>> in hackatimeProjects array');
                throw new Error('The project "<<LAST_PROJECT>>" cannot be linked');
            }
        }
        
        // SECURITY CHECK: Remove restricted fields for non-privileged users
        if (!hasPrivilegedAccess) {
            console.log('[POST-TRACE] 7.4 Non-privileged user detected. Restricting fields.');
            
            if ('shipped' in projectData && projectData.shipped === true) {
                console.warn(`[POST-TRACE] 7.4.4 Removing 'shipped' flag set by non-privileged user ${user.id}`);
                projectData.shipped = false;
            }
            
            if ('viral' in projectData && projectData.viral === true) {
                console.warn(`[POST-TRACE] 7.4.5 Removing 'viral' flag set by non-privileged user ${user.id}`);
                projectData.viral = false;
            }
            
            if ('in_review' in projectData && projectData.in_review === true) {
                console.warn(`[POST-TRACE] 7.4.6 Removing 'in_review' flag set by non-privileged user ${user.id}`);
                projectData.in_review = false;
            }
        }

        // Detailed error trapping around project creation
        console.log('[POST-TRACE] 8. About to call createProject function with data:', {
            ...projectData,
            userId: user.id,
            screenshot: projectData.screenshot ? `(screenshot data, length: ${projectData.screenshot.length})` : '(none)'
        });
        
        try {
            console.time('[POST-TRACE] createProject execution time');
            console.log('[POST-TRACE] 8.1 Using createProject from explicit relative import path');
            
            // Add validation to ensure we're using the correct implementation
            // The proper implementation in lib/project.ts is over 200 lines long
            const createProjectFunctionBody = projectLib.createProject.toString();
            let useCorrectImplementation = true;
            
            if (createProjectFunctionBody.length < 100) {
                console.error('[POST-TRACE] 8.2 WARNING: Potentially using deprecated implementation!');
                console.error('[POST-TRACE] 8.3 Function body length:', createProjectFunctionBody.length);
                console.error('[POST-TRACE] 8.4 Function body preview:', createProjectFunctionBody.substring(0, 100));
                useCorrectImplementation = false;
            } else {
                console.log('[POST-TRACE] 8.2 Verified correct implementation - function body length:', createProjectFunctionBody.length);
            }
            
            let createdProject;
            
            if (useCorrectImplementation) {
                // Use the imported function
                createdProject = await projectLib.createProject({ 
                    ...projectData,
                    userId: user.id
                });
            } else {
                // Last resort: try a direct require as fallback
                console.log('[POST-TRACE] 8.5 Trying fallback direct require from filesystem path');
                try {
                    // Use path relative to project root
                    const fallbackLib = require('fs').readFileSync('lib/project.ts', 'utf8');
                    console.log('[POST-TRACE] 8.6 Successfully read lib/project.ts:', 
                                fallbackLib.length > 0 ? 'File exists and has content' : 'File exists but is empty');
                                
                    // If we get here, we know the file exists but can't directly require it
                    // So we'll need to use the implementation we have, just log a clear warning
                    console.error('[POST-TRACE] 8.7 CRITICAL: Using potentially incorrect implementation after fallback check');
                    
                    createdProject = await projectLib.createProject({ 
                        ...projectData,
                        userId: user.id
                    });
                } catch (error) {
                    const fallbackError = error as Error;
                    console.error('[POST-TRACE] 8.6 Fallback check failed:', fallbackError.message);
                    
                    // Still try the original implementation as last resort
                    createdProject = await projectLib.createProject({ 
                        ...projectData,
                        userId: user.id
                    });
                }
            }
            
            console.timeEnd('[POST-TRACE] createProject execution time');
            console.log('[POST-TRACE] 9. createProject returned successfully');
            
            // Check result
            if (!createdProject) {
                console.error('[POST-TRACE] 9.1 createProject returned null or undefined');
                metrics.increment("errors.create_project_null_result", 1);
                return Response.json({ 
                    success: false, 
                    error: 'Project creation failed - no project data returned',
                    type: 'NullResult'
                }, { status: 500 });
            }
            
            console.log('[POST-TRACE] 10. Successfully created project:', {
                projectID: createdProject.projectID,
                name: createdProject.name,
                userId: createdProject.userId
            });
            
            try {
                console.log('[POST-TRACE] 11. Creating audit log entry');
                // Create audit log for project creation
                await logProjectEvent({
                    eventType: AuditLogEventType.ProjectCreated,
                    description: `Project "${createdProject.name || 'Unnamed'}" was created`,
                    projectId: createdProject.projectID || 'unknown-id',
                    userId: user.id,
                    actorUserId: user.id,
                    metadata: {
                        projectDetails: {
                            projectID: createdProject.projectID || 'unknown-id',
                            name: createdProject.name || 'Unnamed',
                            description: createdProject.description || '',
                            codeUrl: createdProject.codeUrl || "",
                            playableUrl: createdProject.playableUrl || "",
                            screenshot: createdProject.screenshot || "",
                            url: createdProject.projectID ? `/bay/projects/${createdProject.projectID}` : '/bay'
                        }
                    }
                });
                console.log('[POST-TRACE] 12. Audit log created successfully');
            } catch (logError) {
                // Log but don't throw, allow project creation to succeed even if audit log fails
                console.error('[POST-TRACE] 12.1 Failed to create audit log:', logError);
            }
            
            console.log(`[POST-TRACE] 13. Successfully completed project creation ${createdProject.projectID}`);
            metrics.increment("success.create_project", 1);
            return Response.json({ success: true, data: createdProject });
        } catch (createError: unknown) {
            console.error('[POST-TRACE] Error in createProject:', createError);
            if (createError instanceof Error) {
                console.error('[POST-TRACE] Error name:', createError.name);
                console.error('[POST-TRACE] Error message:', createError.message);
                console.error('[POST-TRACE] Error stack:', createError.stack);
            }
            metrics.increment("errors.create_project_exception", 1);
            return Response.json({ 
                success: false, 
                error: createError instanceof Error ? createError.message : 'Unknown error in project creation',
                type: createError instanceof Error && createError.constructor ? createError.constructor.name : 'Unknown'
            }, { status: 500 });
        }
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('[POST-TRACE] FATAL ERROR in project creation flow:', err);
        console.error('[POST-TRACE] Error name:', err.name);
        console.error('[POST-TRACE] Error message:', err.message);
        console.error('[POST-TRACE] Error stack:', err.stack);
        metrics.increment("errors.create_project", 1);
        return Response.json({ 
            success: false, 
            error: err.message,
            type: err.constructor.name
        }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    console.log('[DELETE] Received request to delete project');
    try {
        const user = await requireUserSession();
        console.log(`[DELETE] Authenticated user ${user.id}`);
        
        // Get the referer to check where the request is coming from
        const referer = request.headers.get('referer') || '';
        const isFromAdminPanel = referer.includes('/admin/projects');
        
        // Only allow deletion from the admin panel
        if (!isFromAdminPanel) {
            return Response.json({
                success: false,
                error: 'Sorry, you cannot unlink your hackatime project from Shipwrecked.'
            }, { status: 403 });
        }
        
        // Check if user is an admin
        const isAdmin = user.role === 'Admin' || user.isAdmin === true;
        if (!isAdmin) {
            return Response.json({
                success: false,
                error: 'Only administrators can delete projects'
            }, { status: 403 });
        }
        
        // Get request body and handle potential parsing errors
        let body;
        try {
            body = await request.json();
            console.log('[DELETE] Request body:', body);
        } catch (error) {
            console.error('[DELETE] Failed to parse request body:', error);
            return Response.json({ 
                success: false, 
                error: 'Invalid request body format' 
            }, { status: 400 });
        }

        const { projectID } = body;
        if (!projectID) {
            console.error('[DELETE] No projectID provided in request body');
            return Response.json({ 
                success: false, 
                error: 'projectID is required' 
            }, { status: 400 });
        }

        console.log(`[DELETE] Admin attempting to delete project ${projectID}`);
        
        // Fetch project details before deletion to use in audit log - as admin, we don't restrict by userId
        const projectToDelete = await prisma.project.findUnique({
            where: { projectID },
            include: { 
                user: true,
                hackatimeLinks: true 
            }
        });
        
        if (!projectToDelete) {
            return Response.json({
                success: false,
                error: 'Project not found'
            }, { status: 404 });
        }
        
        // Create audit log for project deletion BEFORE deletion
        console.log(`[DELETE] Creating audit log for admin project deletion: ${projectID}`);
        const auditLogResult = await logProjectEvent({
            eventType: AuditLogEventType.ProjectDeleted,
            description: `Project "${projectToDelete.name}" was deleted by admin`,
            projectId: projectID,
            userId: projectToDelete.userId,
            actorUserId: user.id,
            metadata: {
                projectDetails: {
                    projectID: projectToDelete.projectID,
                    name: projectToDelete.name,
                    description: projectToDelete.description,
                    adminAction: true,
                    ownerEmail: projectToDelete.user?.email
                }
            }
        });
        
        console.log(`[DELETE] Audit log creation result: ${auditLogResult ? 'Success' : 'Failed'}`);
        
        // Delete any reviews associated with the project
        await prisma.review.deleteMany({
            where: { projectID }
        });
        
        // Delete the project - as admin we don't restrict by userId
        await prisma.project.delete({
            where: { projectID }
        });
        
        console.log(`[DELETE] Admin successfully deleted project ${projectID}`);
        metrics.increment("success.admin_delete_project", 1);
        
        return Response.json({ success: true });
    } catch (err) {
        console.error('[DELETE] Failed to delete project:', err);
        metrics.increment("errors.delete_project", 1);
        return Response.json({ 
            success: false, 
            error: err instanceof Error ? err.message : 'Unknown error'
        }, { status: 500 });
    }
}

export async function PUT(request: Request) {
    console.log('[PUT] Received request to update project');
    try {
        const user = await requireUserSession();
        console.log(`[PUT] Authenticated user ${user.id}`);

        // Check content type to determine how to parse the request
        const contentType = request.headers.get('content-type');
        console.log('[PUT] Content-Type:', contentType);

        let projectData: any = {};
        if (contentType?.includes('multipart/form-data')) {
            console.log('[PUT] Parsing FormData');
            const formData = await request.formData();
            projectData = {
                projectID: formData.get('projectID')?.toString() || '',
                name: formData.get('name')?.toString() || '',
                description: formData.get('description')?.toString() || '',
                codeUrl: formData.get('codeUrl')?.toString() || '',
                playableUrl: formData.get('playableUrl')?.toString() || '',
                screenshot: formData.get('screenshot')?.toString() || '',
                chat_enabled: formData.get('chat_enabled') === 'on',
                // These fields will be filtered out for non-admin users
                shipped: formData.get('shipped') === 'true',
                viral: formData.get('viral') === 'true',
                in_review: formData.get('in_review') === 'true',
                hoursOverride: formData.get('hoursOverride') ? parseFloat(formData.get('hoursOverride')?.toString() || '0') : undefined,
                // Collect individual hackatime link overrides
                hackatimeLinkOverrides: {}
            };
            
            // Collect all the individual link overrides from form data (linkOverride-{id})
            for (const [key, value] of formData.entries()) {
                if (key.startsWith('linkOverride-')) {
                    const linkId = key.replace('linkOverride-', '');
                    if (value && value.toString().trim() !== '') {
                        try {
                            const hours = parseFloat(value.toString());
                            if (!isNaN(hours)) {
                                projectData.hackatimeLinkOverrides[linkId] = hours;
                            }
                        } catch (error) {
                            console.warn(`[PUT] Invalid hours value for link override: ${value}`);
                        }
                    }
                }
            }
            
        } else {
            console.log('[PUT] Parsing JSON');
            projectData = await request.json();
            // Ensure rawHours is present and a number
            projectData.hoursOverride = typeof projectData.hoursOverride === 'number' ? projectData.hoursOverride : undefined;
        }

        let { projectID, hackatimeLinkOverrides, ...updateFields } = projectData;
        if (!projectID) {
            return Response.json({ success: false, error: 'projectID is required' }, { status: 400 });
        }

        // Define fields that regular users can update
        const userUpdateableFields = [
            "name",
            "description",
            "codeUrl",
            "playableUrl",
            "screenshot",
            "chat_enabled"
        ];

        // Define fields that only admins can update
        const adminOnlyFields = [
            "shipped",
            "viral",
        ];
        
        // Define fields that admins and reviewers can update
        const reviewerUpdateableFields = [
            "in_review",
            ...userUpdateableFields
        ];

        // Define fields that should never be updated via the API
        const nonUpdateableFields = [
            "hackatimeName"
        ];

        // Check if user is admin
        const isAdmin = user.role === "Admin" || user.isAdmin === true;
        const isReviewer = user.role === "Reviewer";
        
        // If non-admin user attempts to update privileged fields, log it as a potential security issue
        if (!isAdmin) {
            const attemptedAdminFields = Object.keys(updateFields).filter(key => 
                adminOnlyFields.includes(key) && updateFields[key] !== undefined
            );
            
            if (attemptedAdminFields.length > 0) {
                console.warn(`[PUT] Security warning: User ${user.id} attempted to update admin-only fields: ${attemptedAdminFields.join(', ')}`);
                metrics.increment("security.unauthorized_field_update_attempt", 1);
            }
        }
        
        // Explicit security check for rawHours - NEVER allow direct modification via API
        if ('hoursOverride' in updateFields) {
            console.warn(`[PUT] Security alert: Attempt to directly modify hoursOverride detected from user ${user.id}. Value: ${updateFields.hoursOverride}`);
            metrics.increment("security.hoursOverride_modification_attempt", 1);
            delete updateFields.hoursOverride;
        }

        // Filter fields based on user role
        if (isAdmin) {
            // Admins can update all fields except non-updateable ones
            updateFields = Object.fromEntries(
                Object.entries(updateFields).filter(([key, val]) => 
                    !nonUpdateableFields.includes(key) && val !== undefined
                )
            );
        } else if (isReviewer) {
            // Reviewers can update in_review flag and other reviewer-updateable fields
            updateFields = Object.fromEntries(
                Object.entries(updateFields).filter(([key, val]) => 
                    reviewerUpdateableFields.includes(key) && 
                    !nonUpdateableFields.includes(key) && 
                    val !== undefined
                )
            );
        } else {
            // Regular users can only update basic fields
            updateFields = Object.fromEntries(
                Object.entries(updateFields).filter(([key, val]) => 
                    userUpdateableFields.includes(key) && 
                    !nonUpdateableFields.includes(key) && 
                    val !== undefined
                )
            );
        }
        
        console.log(`[PUT] Updating project ${projectID} with fields:`, updateFields);
        console.log(`[PUT] Hackatime link overrides:`, hackatimeLinkOverrides);
        
        // Verify the project exists before attempting to update
        let existingProject;
        
        // If user is admin, allow editing any project
        if (isAdmin) {
            existingProject = await prisma.project.findUnique({
                where: { projectID },
                include: {
                    hackatimeLinks: true // Include Hackatime links for updating overrides
                }
            });
        } else {
            // Regular users can only edit their own projects
            existingProject = await prisma.project.findUnique({
                where: {
                    projectID_userId: {
                        projectID,
                        userId: user.id
                    }
                }
            });
        }
        
        if (!existingProject) {
            console.error(`[PUT] Project ${projectID} not found for user ${user.id}`);
            return Response.json({ 
                success: false, 
                error: 'Project not found' 
            }, { status: 404 });
        }
        
        try {
            // First update the project fields
            const updatedProject = await prisma.project.update({
                where: isAdmin 
                    ? { projectID } // Admins can update any project by ID
                    : { // Regular users can only update their own projects
                        projectID_userId: {
                            projectID,
                            userId: user.id
                        }
                    },
                data: updateFields,
                include: {
                    hackatimeLinks: true // Return updated links with the response
                }
            });
            
            // If admin or reviewer is updating individual link hour overrides
            if ((isAdmin || isReviewer) && hackatimeLinkOverrides && Object.keys(hackatimeLinkOverrides).length > 0) {
                console.log(`[PUT] Processing ${Object.keys(hackatimeLinkOverrides).length} Hackatime link overrides`);
                
                // Update each link with its override if provided
                for (const [linkId, hours] of Object.entries(hackatimeLinkOverrides)) {
                    if (typeof hours === 'number' && !isNaN(hours)) {
                        await prisma.hackatimeProjectLink.update({
                            where: { id: linkId },
                            data: { hoursOverride: hours }
                        });
                    } else if (hours === null || hours === undefined || hours === '') {
                        // If the override is cleared, set it to null
                        await prisma.hackatimeProjectLink.update({
                            where: { id: linkId },
                            data: { hoursOverride: null }
                        });
                    }
                }
                
                // Re-fetch the project with updated links
                const refreshedProject = await prisma.project.findUnique({
                    where: { projectID },
                    include: {
                        hackatimeLinks: true
                    }
                });
                
                if (refreshedProject) {
                    // Calculate total hours from all links with overrides applied
                    const totalHours = refreshedProject.hackatimeLinks.reduce((sum, link) => {
                        const effectiveHours = link.hoursOverride !== null && link.hoursOverride !== undefined
                            ? link.hoursOverride
                            : link.rawHours;
                        return sum + effectiveHours;
                    }, 0);
                    
                    console.log(`[PUT] Total calculated hours after override updates: ${totalHours}`);
                }
            }

            console.log(`[PUT] Successfully updated project ${projectID}`);
            metrics.increment("success.update_project", 1);
            
            // Add audit logging for admin and reviewer project edits
            if (isAdmin || isReviewer) {
                try {
                    // Gather summary of changes for the audit log
                    const fieldsChanged = Object.keys(updateFields);
                    const linksChanged = Object.keys(hackatimeLinkOverrides || {}).length;
                    
                    // Create descriptive text about the changes
                    let changeDescription = isAdmin 
                        ? `Admin edited project "${existingProject.name}"`
                        : `Reviewer edited project "${existingProject.name}"`;
                    if (fieldsChanged.length > 0) {
                        changeDescription += `. Updated fields: ${fieldsChanged.join(', ')}`;
                    }
                    if (linksChanged > 0) {
                        changeDescription += `. Modified ${linksChanged} Hackatime link override${linksChanged !== 1 ? 's' : ''}`;
                    }
                    
                    // Log the admin edit as an OtherEvent
                    await logProjectEvent({
                        eventType: AuditLogEventType.OtherEvent,
                        description: changeDescription,
                        projectId: projectID,
                        userId: existingProject.userId,
                        actorUserId: user.id,
                        metadata: {
                            action: "admin_project_edit",
                            fieldsUpdated: updateFields,
                            hackatimeLinkOverrides: hackatimeLinkOverrides || {},
                            originalValues: {
                                name: existingProject.name,
                                description: existingProject.description,
                                shipped: existingProject.shipped,
                                viral: existingProject.viral,
                                in_review: existingProject.in_review
                            }
                        }
                    });
                    
                    console.log(`[PUT] Created audit log for admin project edit`);
                } catch (auditError) {
                    // Don't let audit logging failure break the main functionality
                    console.error(`[PUT] Failed to create audit log for admin project edit:`, auditError);
                }
            }
            
            // Re-fetch the project with fresh data after all updates
            const finalProject = await prisma.project.findUnique({
                where: { projectID },
                include: {
                    hackatimeLinks: true
                }
            });
            
            return Response.json({ 
                success: true, 
                data: finalProject || { projectID }
            });
        } catch (updateError) {
            console.error(`[PUT] Prisma error updating project ${projectID}:`, updateError);
            return Response.json({ 
                success: false, 
                error: 'Database error updating project',
                details: updateError instanceof Error ? updateError.message : 'Unknown error' 
            }, { status: 500 });
        }
    } catch (error: unknown) {
        // This catch block now only catches errors from requireUserSession or request parsing
        const err = error instanceof Error ? error : new Error(String(error));
        console.error('[PUT] Failed to process request:', err);
        metrics.increment("errors.update_project", 1);
        return Response.json({ 
            success: false, 
            error: err.message,
            type: err.constructor.name
        }, { status: 500 });
    }
}
