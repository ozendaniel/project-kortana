import { useQuery } from '@tanstack/react-query';
import { getSavings } from '../api/client';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function SavingsDashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['savings'],
    queryFn: getSavings,
  });

  if (isLoading) return <p className="text-gray-400">Loading savings data...</p>;
  if (error || !data) return <p className="text-red-500">Error loading savings.</p>;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Your Savings</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-3xl font-bold text-green-600">
            {formatCents(data.totalSavingsCents)}
          </p>
          <p className="text-sm text-gray-500 mt-1">Total Saved</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-3xl font-bold text-gray-900">{data.totalOrders}</p>
          <p className="text-sm text-gray-500 mt-1">Orders Compared</p>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-3xl font-bold text-blue-600">
            {formatCents(data.averageSavingsPerOrderCents)}
          </p>
          <p className="text-sm text-gray-500 mt-1">Avg Savings / Order</p>
        </div>
      </div>

      {Object.keys(data.platformBreakdown).length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Platform Breakdown</h2>
          <div className="space-y-3">
            {Object.entries(data.platformBreakdown).map(([platform, stats]) => (
              <div key={platform} className="flex items-center justify-between">
                <span className="font-medium text-gray-700">
                  {platform === 'doordash' ? 'DoorDash' : platform === 'seamless' ? 'Seamless' : 'Uber Eats'}
                </span>
                <div className="text-sm text-gray-500">
                  Chosen {stats.timesChosen}x &mdash; {formatCents(stats.totalSpentCents)} spent
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
