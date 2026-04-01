import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAuthStatus } from '../api/client';

export default function AuthBanner() {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const { data: authStatus } = useQuery({
    queryKey: ['authStatus'],
    queryFn: getAuthStatus,
    refetchInterval: 30000,
  });

  if (!authStatus) return null;

  const expiredPlatforms = Object.entries(authStatus)
    .filter(([name, status]) => status === 'expired' && !dismissed.has(name))
    .map(([name]) => name);

  if (expiredPlatforms.length === 0) return null;

  const labels: Record<string, string> = { doordash: 'DoorDash', seamless: 'Seamless' };
  const names = expiredPlatforms.map(p => labels[p] || p).join(' and ');

  return (
    <div className="bg-amber-bg border-b border-border animate-slide-down">
      <div className="max-w-5xl mx-auto px-5 py-2.5 flex items-center justify-between">
        <span className="text-xs font-mono text-amber-accent tracking-wide">
          {names} session expired &mdash;{' '}
          <a href="/settings" className="underline hover:text-text-primary transition-colors">
            reconnect
          </a>
        </span>
        <button
          onClick={() => {
            const next = new Set(dismissed);
            expiredPlatforms.forEach(p => next.add(p));
            setDismissed(next);
          }}
          className="text-text-muted hover:text-text-secondary text-xs transition-colors"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
