import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthStatus } from '../api/client';
import BrowserView from './BrowserView';

const PLATFORM_LABELS: Record<string, string> = {
  doordash: 'DoorDash',
  seamless: 'Seamless',
};

const PLATFORM_ABBR: Record<string, string> = {
  doordash: 'DD',
  seamless: 'SL',
};

const STATUS_CONFIG: Record<string, { dot: string; label: string; labelColor: string }> = {
  authenticated: { dot: 'bg-lime', label: 'Connected', labelColor: 'text-lime' },
  expired: { dot: 'bg-coral', label: 'Expired', labelColor: 'text-coral' },
  logging_in: { dot: 'bg-amber-accent', label: 'Logging in...', labelColor: 'text-amber-accent' },
  not_configured: { dot: 'bg-text-muted', label: 'Not configured', labelColor: 'text-text-muted' },
};

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [loginPlatform, setLoginPlatform] = useState<string | null>(null);

  const { data: authStatus, isLoading } = useQuery({
    queryKey: ['authStatus'],
    queryFn: getAuthStatus,
    refetchInterval: 10000,
  });

  const handleLoginComplete = useCallback(() => {
    setTimeout(() => {
      setLoginPlatform(null);
      queryClient.invalidateQueries({ queryKey: ['authStatus'] });
    }, 1500);
  }, [queryClient]);

  const handleLoginError = useCallback((error: string) => {
    console.error('Login error:', error);
    setTimeout(() => setLoginPlatform(null), 3000);
  }, []);

  return (
    <div className="max-w-2xl mx-auto animate-fade-up">
      <h1 className="font-display text-3xl text-text-primary tracking-tight italic mb-6">
        Settings
      </h1>

      <section className="bg-surface border border-border-subtle rounded-sm overflow-hidden">
        <div className="px-5 py-3 border-b border-border-subtle">
          <h2 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase">
            Platform Connections
          </h2>
        </div>

        {isLoading ? (
          <div className="p-5 space-y-3">
            <div className="skeleton h-14 rounded-sm" />
            <div className="skeleton h-14 rounded-sm" />
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {['doordash', 'seamless'].map((platform) => {
              const status = authStatus?.[platform as keyof typeof authStatus] || 'not_configured';
              const config = STATUS_CONFIG[status] ?? STATUS_CONFIG['not_configured']!;
              const canConnect = status === 'expired' || status === 'not_configured';
              const accent = platform === 'doordash' ? 'text-dd bg-dd-bg' : 'text-sl bg-sl-bg';

              return (
                <div key={platform} className="flex items-center justify-between px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className={`font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded-sm ${accent}`}>
                      {PLATFORM_ABBR[platform]}
                    </span>
                    <div>
                      <div className="text-sm font-medium text-text-primary">
                        {PLATFORM_LABELS[platform]}
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
                        <span className={`text-[10px] font-mono ${config.labelColor}`}>
                          {config.label}
                        </span>
                      </div>
                    </div>
                  </div>
                  {canConnect && (
                    <button
                      onClick={() => setLoginPlatform(platform)}
                      className="px-4 py-2 bg-surface-hover text-text-primary text-xs font-mono font-medium rounded-sm border border-border hover:border-lime hover:text-lime transition-colors tracking-wide"
                    >
                      Connect
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Login modal */}
      {loginPlatform && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 animate-fade-in">
          <div className="bg-surface border border-border rounded-sm max-w-5xl w-full max-h-[90vh] overflow-auto animate-fade-up">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle">
              <h3 className="text-xs font-mono font-semibold text-text-muted tracking-widest uppercase">
                Connect {PLATFORM_LABELS[loginPlatform]}
              </h3>
              <button
                onClick={() => setLoginPlatform(null)}
                className="text-text-muted hover:text-text-primary text-sm transition-colors"
              >
                &times;
              </button>
            </div>
            <div className="p-5">
              <BrowserView
                platform={loginPlatform}
                onComplete={handleLoginComplete}
                onError={handleLoginError}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
