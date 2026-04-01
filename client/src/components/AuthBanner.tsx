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
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-3">
      <div className="max-w-6xl mx-auto flex items-center justify-between">
        <span className="text-sm text-amber-800">
          {names} session expired.{' '}
          <a href="/settings" className="underline font-medium hover:text-amber-900">
            Reconnect in Settings
          </a>
        </span>
        <button
          onClick={() => {
            const next = new Set(dismissed);
            expiredPlatforms.forEach(p => next.add(p));
            setDismissed(next);
          }}
          className="text-amber-600 hover:text-amber-800 text-sm"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
