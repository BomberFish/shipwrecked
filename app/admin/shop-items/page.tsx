'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { calculateShellPrice } from '@/lib/shop-utils';

interface ShopItem {
  id: string;
  name: string;
  description: string;
  image?: string;
  price: number;
  active: boolean;
  useRandomizedPricing: boolean;
  usdCost?: number;
  costType?: 'fixed' | 'config';
  config?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface GlobalConfig {
  dollars_per_hour?: string;
  price_random_min_percent?: string;
  price_random_max_percent?: string;
}

interface PricingConfig {
  minPercent: string;
  maxPercent: string;
}

interface ShopOrder {
  id: string;
  itemId: string;
  itemName: string;
  price: number;
  quantity: number;
  status: string;
  createdAt: string;
  user: {
    id: string;
    name: string;
    email: string;
  };
}

const TIME_RANGES = [
  { label: '1h', value: '1h', ms: 60 * 60 * 1000 },
  { label: '24h', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'All Time', value: 'all', ms: null },
];

export default function ShopItemsPage() {
  const { data: session, status } = useSession();
  const [items, setItems] = useState<ShopItem[]>([]);
  const [globalConfig, setGlobalConfig] = useState<GlobalConfig>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingItem, setEditingItem] = useState<ShopItem | null>(null);
  const [pricingConfig, setPricingConfig] = useState<PricingConfig>({
    minPercent: '90',
    maxPercent: '110'
  });
  const [dollarsPerHour, setDollarsPerHour] = useState<string>('');
  const [isShopAdmin, setIsShopAdmin] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    description: string;
    image: string;
    price: string;
    usdCost: string;
    costType: 'fixed' | 'config';
    config: string;
    useRandomizedPricing: boolean;
  }>({
    name: '',
    description: '',
    image: '',
    price: '',
    usdCost: '',
    costType: 'fixed',
    config: '',
    useRandomizedPricing: true,
  });
  const [orders, setOrders] = useState<ShopOrder[]>([]);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(TIME_RANGES[3]);
  const [itemStats, setItemStats] = useState<Record<string, {
    unitsSold: number;
    totalRevenue: number;
    avgPrice: number;
  }>>({});

  useEffect(() => {
    fetchData();
  }, []);

  // Fetch shop admin status
  useEffect(() => {
    if (status === 'authenticated') {
      fetch('/api/users/me').then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setIsShopAdmin(!!data.isShopAdmin);
        }
      });
    }
  }, [status]);

  // Add effect to auto-calculate price for config items
  useEffect(() => {
    if (formData.costType === 'config') {
      let configObj: Record<string, unknown> = {};
      try {
        configObj = formData.config ? JSON.parse(formData.config) : {};
      } catch {}
      const usdCost = parseFloat(formData.usdCost);
      const phi = (1 + Math.sqrt(5)) / 2;
      
      if (configObj.dollars_per_hour && !isNaN(usdCost)) {

        const itemDollarsPerHour = parseFloat(configObj.dollars_per_hour as string);
        const hours = usdCost / itemDollarsPerHour; // Convert USD to hours using item's rate
        const shells = Math.round(hours * phi * 10);
        if (formData.price !== shells.toString()) {
          setFormData((prev) => ({ ...prev, price: shells.toString() }));
        }
      } else if (configObj.hours_equal_to_one_percent_progress) {
        // For island progress items with hours_equal_to_one_percent_progress
        // Calculate shells directly from hours, not from USD cost
        const hours = configObj.hours_equal_to_one_percent_progress as number;
        const shells = Math.round(hours * phi * 10);
        if (formData.price !== shells.toString()) {
          setFormData((prev) => ({ ...prev, price: shells.toString() }));
        }
      }
    }
    // For other config types, do not auto-calculate
    // eslint-disable-next-line
  }, [formData.config, formData.usdCost, formData.costType]);

  // Fetch fulfilled orders for analytics
  useEffect(() => {
    async function fetchOrders() {
      setAnalyticsLoading(true);
      setAnalyticsError(null);
      try {
        const res = await fetch('/api/admin/shop-orders?status=fulfilled');
        if (!res.ok) throw new Error('Failed to fetch orders');
        const data = await res.json();
        setOrders(data.orders || []);
      } catch (err) {
        setAnalyticsError(err instanceof Error ? err.message : 'Failed to fetch orders');
      } finally {
        setAnalyticsLoading(false);
      }
    }
    fetchOrders();
  }, []);

  // Compute item stats for selected time range
  useEffect(() => {
    if (!orders.length || !items.length) {
      setItemStats({});
      return;
    }
    const now = Date.now();
    const rangeMs = selectedRange.ms;
    const stats: Record<string, { unitsSold: number; totalRevenue: number; avgPrice: number }> = {};
    for (const item of items) {
      stats[item.id] = { unitsSold: 0, totalRevenue: 0, avgPrice: 0 };
    }
    for (const order of orders) {
      const orderTime = new Date(order.createdAt).getTime();
      if (rangeMs && now - orderTime > rangeMs) continue;
      if (!order.itemId || !stats[order.itemId]) continue;
      stats[order.itemId].unitsSold += order.quantity;
      stats[order.itemId].totalRevenue += order.price;
    }
    for (const itemId in stats) {
      const s = stats[itemId];
      s.avgPrice = s.unitsSold > 0 ? Math.round(s.totalRevenue / s.unitsSold) : 0;
    }
    setItemStats(stats);
  }, [orders, items, selectedRange]);

  const fetchData = async () => {
    try {
      // Fetch shop items
      const itemsResponse = await fetch('/api/admin/shop-items');
      if (itemsResponse.ok) {
        const itemsData = await itemsResponse.json();
        setItems(itemsData.items);
      }

      // Fetch global config
      const configResponse = await fetch('/api/admin/global-config');
      if (configResponse.ok) {
        const configData = await configResponse.json();
        setGlobalConfig(configData.config);
        
        // Initialize pricing config state
        setPricingConfig({
          minPercent: configData.config.price_random_min_percent || '90',
          maxPercent: configData.config.price_random_max_percent || '110'
        });
        
        // Initialize dollars per hour state
        setDollarsPerHour(configData.config.dollars_per_hour || '');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };



  const savePricingConfig = async () => {
    try {
      setError(null);
      console.log('Saving pricing config:', pricingConfig);
      
      const oldDollarsPerHour = parseFloat(globalConfig.dollars_per_hour || '0');
      const newDollarsPerHour = parseFloat(dollarsPerHour || '0');
      
      // Update dollars per hour
      if (dollarsPerHour !== (globalConfig.dollars_per_hour || '')) {
        const dollarsResponse = await fetch('/api/admin/global-config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'dollars_per_hour', value: dollarsPerHour }),
        });
        
        const dollarsResult = await dollarsResponse.json();
        console.log('Dollars per hour response:', dollarsResult);
        
        if (!dollarsResponse.ok) {
          throw new Error(dollarsResult.error || 'Failed to update dollars per hour');
        }
        
        // Recalculate prices for fixed items when dollars per hour changes
        if (oldDollarsPerHour !== newDollarsPerHour && newDollarsPerHour > 0) {
          console.log('Recalculating prices for fixed items...');
          
          const recalculateResponse = await fetch('/api/admin/shop-items/recalculate-prices', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dollarsPerHour: newDollarsPerHour }),
          });
          
          if (!recalculateResponse.ok) {
            const recalculateResult = await recalculateResponse.json();
            console.warn('Price recalculation failed:', recalculateResult.error);
            // Don't fail the whole operation, just warn
          } else {
            const recalculateResult = await recalculateResponse.json();
            console.log('Price recalculation result:', recalculateResult);
          }
        }
      }
      
      // Update min percent
      const minResponse = await fetch('/api/admin/global-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'price_random_min_percent', value: pricingConfig.minPercent }),
      });
      
      const minResult = await minResponse.json();
      console.log('Min percent response:', minResult);
      
      if (!minResponse.ok) {
        throw new Error(minResult.error || 'Failed to update min percent');
      }
      
      // Update max percent
      const maxResponse = await fetch('/api/admin/global-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'price_random_max_percent', value: pricingConfig.maxPercent }),
      });
      
      const maxResult = await maxResponse.json();
      console.log('Max percent response:', maxResult);
      
      if (!maxResponse.ok) {
        throw new Error(maxResult.error || 'Failed to update max percent');
      }
      
      // Update the global config state to reflect the new values
      setGlobalConfig(prev => ({
        ...prev,
        dollars_per_hour: dollarsPerHour,
        price_random_min_percent: pricingConfig.minPercent,
        price_random_max_percent: pricingConfig.maxPercent
      }));
      
      console.log('Successfully saved configuration');
      setSuccessMessage('Global configuration saved successfully!');
      setTimeout(() => setSuccessMessage(null), 3000);
      
      // Refresh items to show updated prices
      await fetchData();
    } catch (err) {
      console.error('Save error:', err);
      setError(err instanceof Error ? err.message : 'Failed to save configuration');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    try {
      const config = formData.config ? JSON.parse(formData.config) : null;
      
      // Auto-calculate shell price for fixed (non-dynamic) items only
      let finalPrice = parseInt(formData.price);
      const usdCost = parseFloat(formData.usdCost);
      const dollarsPerHour = parseFloat(globalConfig.dollars_per_hour || '0');

      if (formData.costType !== 'config' && usdCost > 0 && dollarsPerHour > 0) {
        finalPrice = calculateShellPrice(usdCost, dollarsPerHour);
      }

      const payload = {
        name: formData.name,
        description: formData.description,
        image: formData.image || null,
        price: finalPrice,
        usdCost,
        costType: formData.costType,
        config,
        useRandomizedPricing: formData.useRandomizedPricing,
      };

      const url = editingItem 
        ? `/api/admin/shop-items/${editingItem.id}`
        : '/api/admin/shop-items';
      
      const method = editingItem ? 'PUT' : 'POST';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save item');
      }

      // Reset form and close modal
      setFormData({ name: '', description: '', image: '', price: '', usdCost: '', costType: 'fixed', config: '', useRandomizedPricing: true });
      setEditingItem(null);
      setShowAddModal(false);
      
      // Refresh items
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save item');
    }
  };

  const handleEdit = (item: ShopItem) => {
    setEditingItem(item);
    setFormData({
      name: item.name,
      description: item.description,
      image: item.image || '',
      price: item.price.toString(),
      usdCost: item.usdCost?.toString() || '',
      costType: item.costType || 'fixed',
      config: item.config ? JSON.stringify(item.config, null, 2) : '',
      useRandomizedPricing: item.useRandomizedPricing ?? true,
    });
    setShowAddModal(true);
  };

  const handleDelete = async (itemId: string) => {
    if (!confirm('Are you sure you want to delete this item?')) return;

    try {
      const response = await fetch(`/api/admin/shop-items/${itemId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete item');
      }

      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete item');
    }
  };

  const toggleActive = async (item: ShopItem) => {
    try {
      const response = await fetch(`/api/admin/shop-items/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name,
          description: item.description,
          image: item.image,
          price: item.price,
          usdCost: item.usdCost,
          costType: item.costType,
          config: item.config,
          active: !item.active,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update item');
      }

      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update item');
    }
  };

  if (status === 'unauthenticated' || session?.user?.role !== 'Admin' || !isShopAdmin) {
    return <div>Access denied. Only authorized shop administrators can access this page.</div>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold text-gray-900">Shop Items Management</h1>
        <button
          onClick={() => {
            setEditingItem(null);
            setFormData({ name: '', description: '', image: '', price: '', usdCost: '', costType: 'fixed', config: '', useRandomizedPricing: true });
            setShowAddModal(true);
          }}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition"
        >
          Add New Item
        </button>
      </div>

      {/* Global Config Section */}
      <div className="bg-white shadow rounded-lg p-6">
        <h2 className="text-xl font-semibold mb-4">Global Configuration</h2>
        <div className="space-y-4">
          <div className="flex items-center space-x-4">
            <label className="text-sm font-medium text-gray-700">Dollars per Hour:</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={dollarsPerHour}
              onChange={(e) => setDollarsPerHour(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
              placeholder="Set global rate"
            />
            <span className="text-sm text-gray-500">
              Used to auto-calculate shell prices for non-special items
            </span>
          </div>
          
          <div className="border-t pt-4">
            <h3 className="text-lg font-medium text-gray-900 mb-3">Randomized Pricing</h3>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="flex items-center space-x-2">
                <label className="text-sm font-medium text-gray-700">Min Percent:</label>
                <input
                  type="number"
                  min="1"
                  max="200"
                  step="1"
                  value={pricingConfig.minPercent}
                  onChange={(e) => setPricingConfig({ ...pricingConfig, minPercent: e.target.value })}
                  className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500 w-20"
                  placeholder="90"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
              <div className="flex items-center space-x-2">
                <label className="text-sm font-medium text-gray-700">Max Percent:</label>
                <input
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={pricingConfig.maxPercent}
                  onChange={(e) => setPricingConfig({ ...pricingConfig, maxPercent: e.target.value })}
                  className="border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500 w-20"
                  placeholder="110"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
            <p className="text-sm text-gray-500 mb-3">
              Each user gets randomized pricing hourly within this range. For example, 90-110% means 10% off to 10% more expensive.
            </p>
            <div className="flex justify-end">
              <button
                onClick={savePricingConfig}
                className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition font-medium"
              >
                Save Global Config
              </button>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {successMessage && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-800">{successMessage}</p>
        </div>
      )}

      {/* Table Section */}
      <div className="bg-white shadow rounded-lg overflow-x-auto w-full">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Item
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Shells
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                USD Cost
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Type
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Pricing Mode
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-gray-50">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    {item.image && (
                      <img
                        src={item.image}
                        alt={item.name}
                        className="w-10 h-10 rounded-lg object-cover mr-3"
                      />
                    )}
                    <div>
                      <div className="text-sm font-medium text-gray-900">{item.name}</div>
                      <div className="text-sm text-gray-500">{item.description}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="flex items-center">
                    <img src="/shell_720.png" alt="Shell" className="w-4 h-4 mr-1" />
                    <span className="text-sm text-gray-900">{item.price}</span>
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className="text-sm text-gray-900">${item.usdCost?.toFixed(2) || '0.00'}</span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    item.costType === 'config'
                      ? 'bg-purple-100 text-purple-800'
                      : 'bg-blue-100 text-blue-800'
                  }`}>
                    {item.costType === 'config' ? 'Special' : 'Auto-calculated'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                    item.useRandomizedPricing
                      ? 'bg-orange-100 text-orange-800'
                      : 'bg-gray-100 text-gray-800'
                  }`}>
                    {item.useRandomizedPricing ? 'Randomized' : 'Static'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap">
                  <span
                    className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                      item.active
                        ? 'bg-green-100 text-green-800'
                        : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {item.active ? 'Active' : 'Inactive'}
                  </span>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex justify-end space-x-2">
                    <button
                      onClick={() => toggleActive(item)}
                      className={`px-3 py-1 rounded text-xs ${
                        item.active
                          ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                          : 'bg-green-100 text-green-800 hover:bg-green-200'
                      }`}
                    >
                      {item.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => handleEdit(item)}
                      className="text-blue-600 hover:text-blue-900 px-3 py-1 rounded text-xs bg-blue-50 hover:bg-blue-100"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="text-red-600 hover:text-red-900 px-3 py-1 rounded text-xs bg-red-50 hover:bg-red-100"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add/Edit Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-full max-w-[95vw] sm:max-w-2xl shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {editingItem ? 'Edit Shop Item' : 'Add New Shop Item'}
              </h3>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Name</label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Description</label>
                  <textarea
                    required
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    rows={3}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Image URL (optional)</label>
                  <input
                    type="url"
                    value={formData.image}
                    onChange={(e) => setFormData({ ...formData, image: e.target.value })}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">USD Cost (per unit)</label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    value={formData.usdCost}
                    onChange={(e) => setFormData({ ...formData, usdCost: e.target.value })}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    This is the base USD price for one unit of this item. This includes manual fullfillment costs (e.g shipping).
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700">Cost Type</label>
                  <select
                    required
                    value={formData.costType}
                    onChange={(e) => setFormData({ ...formData, costType: e.target.value as 'fixed' | 'config' })}
                    className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500"
                  >
                    <option value="fixed">Fixed</option>
                    <option value="config">Config (dynamic)</option>
                  </select>
                </div>
                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="useRandomizedPricing"
                    checked={formData.useRandomizedPricing}
                    onChange={(e) => setFormData({ ...formData, useRandomizedPricing: e.target.checked })}
                    className="mr-2 h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="useRandomizedPricing" className="text-sm font-medium text-gray-700">
                    Use randomized pricing
                  </label>
                  <div className="ml-2">
                    <span className="text-xs text-gray-500">
                      (If unchecked, item will use static price)
                    </span>
                  </div>
                </div>
                {formData.costType === 'config' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700">Config (JSON, required for dynamic cost)</label>
                    <textarea
                      required
                      value={formData.config}
                      onChange={(e) => setFormData({ ...formData, config: e.target.value })}
                      rows={4}
                      placeholder='{"hours_equal_to_one_percent_progress": 0.8} or {"dollars_per_hour": 10}'
                      className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-blue-500 focus:border-blue-500 font-mono text-sm"
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      For travel stipend: <code>{'{"dollars_per_hour": 10}'}</code> (custom hourly rate for this item)<br/>
                      For island progress: <code>{'{"hours_equal_to_one_percent_progress": 0.6}'}</code> (hours per 1% progress, price = round(hours × φ × 10))
                    </p>
                  </div>
                )}
                {formData.costType !== 'config' && formData.usdCost && globalConfig.dollars_per_hour && (
                  <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                    <p className="text-sm text-blue-800">
                      <strong>Auto-calculated shell price:</strong> {calculateShellPrice(parseFloat(formData.usdCost), parseFloat(globalConfig.dollars_per_hour))} shells
                      <br />
                      <span className="text-xs">Formula: (${parseFloat(formData.usdCost)} ÷ {parseFloat(globalConfig.dollars_per_hour)}) × φ × 10 = {calculateShellPrice(parseFloat(formData.usdCost), parseFloat(globalConfig.dollars_per_hour))} shells</span>
                    </p>
                  </div>
                )}
                {formData.costType === 'config' && formData.config && (() => {
                  try {
                    const configObj = JSON.parse(formData.config || '{}');
                    
                    if (configObj.dollars_per_hour && formData.usdCost) {
                      const usdCost = parseFloat(formData.usdCost);
                      const phi = (1 + Math.sqrt(5)) / 2;
                      const itemDollarsPerHour = parseFloat(configObj.dollars_per_hour as string);
                      const hours = usdCost / itemDollarsPerHour;
                      const shells = Math.round(hours * phi * 10);
                      return (
                        <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                          <p className="text-sm text-green-800">
                            <strong>Auto-calculated shell price (Travel Stipend):</strong> {shells} shells
                            <br />
                            <span className="text-xs">Auto-calculated: {shells} shells</span>
                          </p>
                        </div>
                      );
                    }
                    if (configObj.hours_equal_to_one_percent_progress && formData.usdCost) {
                      const hours = configObj.hours_equal_to_one_percent_progress as number;
                      const phi = (1 + Math.sqrt(5)) / 2;
                      const shells = Math.round(hours * phi * 10);
                      return (
                        <div className="bg-purple-50 border border-purple-200 rounded-lg p-3">
                          <p className="text-sm text-purple-800">
                            <strong>Auto-calculated shell price (Island Progress):</strong> {shells} shells
                            <br />
                            <span className="text-xs">Formula: {hours} hours × φ × 10 = {(hours * phi * 10).toFixed(1)} → round = {shells} shells</span>
                          </p>
                        </div>
                      );
                    }
                  } catch {
                    // Invalid JSON, don't show anything
                  }
                  return null;
                })()}
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddModal(false);
                      setEditingItem(null);
                      setFormData({ name: '', description: '', image: '', price: '', usdCost: '', costType: 'fixed', config: '', useRandomizedPricing: true });
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                  >
                    {editingItem ? 'Update' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 
