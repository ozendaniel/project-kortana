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

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-8 w-48 rounded-sm" />
        <div className="grid grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="skeleton h-28 rounded-sm" />
          ))}
        </div>
      </div>
    );
  }
  if (error || !data) return <p className="text-coral text-sm font-mono">Error loading savings.</p>;

  return (
    <div className="space-y-8 animate-fade-up">
      <h1 className="font-display text-3xl text-text-primary tracking-tight italic">
        Your Savings
      </h1>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 stagger">
        <StatCard
          value={formatCents(data.totalSavingsCents)}
          label="Total Saved"
          accent="lime"
        />
        <StatCard
          value={String(data.totalOrders)}
          label="Orders Compared"
          accent="primary"
        />
        <StatCard
          value={formatCents(data.averageSavingsPerOrderCents)}
          label="Avg per Order"
          accent="secondary"
        />
      </div>

      {/* Platform breakdown */}
      {Object.keys(data.platformBreakdown).length > 0 && (
        <div className="bg-surface border border-border-subtle rounded-sm animate-fade-up" style={{ animationDelay: '200ms' }}>
          <div className="px-5 py-3 border-b border-border-subtle">
            <h2 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase">
              Platform Breakdown
            </h2>
          </div>
          <div className="divide-y divide-border-subtle">
            {Object.entries(data.platformBreakdown).map(([platform, stats]) => {
              const label = platform === 'doordash' ? 'DoorDash' : platform === 'seamless' ? 'Seamless' : 'Uber Eats';
              const abbr = platform === 'doordash' ? 'DD' : 'SL';
              const accent = platform === 'doordash' ? 'text-dd' : 'text-sl';
              const accentBg = platform === 'doordash' ? 'bg-dd-bg' : 'bg-sl-bg';

              return (
                <div key={platform} className="flex items-center justify-between px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-sm ${accentBg} ${accent}`}>
                      {abbr}
                    </span>
                    <span className="text-sm text-text-primary">{label}</span>
                  </div>
                  <div className="flex items-center gap-4 text-xs font-mono text-text-secondary">
                    <span>{stats.timesChosen}x chosen</span>
                    <span className="price">{formatCents(stats.totalSpentCents)} spent</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ value, label, accent }: { value: string; label: string; accent: 'lime' | 'primary' | 'secondary' }) {
  const valueColor = {
    lime: 'text-lime',
    primary: 'text-text-primary',
    secondary: 'text-text-secondary',
  }[accent];

  return (
    <div className="bg-surface border border-border-subtle rounded-sm p-5">
      <p className={`price text-3xl font-bold ${valueColor} animate-count-up`}>
        {value}
      </p>
      <p className="text-[10px] font-mono text-text-muted tracking-widest uppercase mt-2">
        {label}
      </p>
    </div>
  );
}
