import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthStatus } from '../api/client';
import BrowserView from './BrowserView';

const PLATFORM_LABELS: Record<string, string> = {
  doordash: 'DoorDash',
  seamless: 'Seamless',
};

const STATUS_STYLES: Record<string, { dot: string; label: string; text: string }> = {
  authenticated: { dot: 'bg-green-500', label: 'Connected', text: 'text-green-700' },
  expired: { dot: 'bg-red-500', label: 'Session expired', text: 'text-red-700' },
  logging_in: { dot: 'bg-yellow-500', label: 'Logging in...', text: 'text-yellow-700' },
  not_configured: { dot: 'bg-gray-400', label: 'Not configured', text: 'text-gray-500' },
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
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Settings</h1>

      <section className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Platform Connections</h2>
        <p className="text-sm text-gray-500 mb-6">
          Connect your DoorDash and Seamless accounts to enable live price comparison.
        </p>

        {isLoading ? (
          <div className="text-gray-500 text-sm">Loading...</div>
        ) : (
          <div className="space-y-4">
            {['doordash', 'seamless'].map((platform) => {
              const status = authStatus?.[platform as keyof typeof authStatus] || 'not_configured';
              const style = STATUS_STYLES[status] ?? STATUS_STYLES['not_configured']!;
              const canConnect = status === 'expired' || status === 'not_configured';

              return (
                <div
                  key={platform}
                  className="flex items-center justify-between p-4 rounded-lg border border-gray-100 bg-gray-50"
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${style.dot}`} />
                    <div>
                      <div className="font-medium text-gray-900">
                        {PLATFORM_LABELS[platform] || platform}
                      </div>
                      <div className={`text-xs ${style.text}`}>{style.label}</div>
                    </div>
                  </div>
                  {canConnect && (
                    <button
                      onClick={() => setLoginPlatform(platform)}
                      className="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-800 transition-colors"
                    >
                      Connect
                    </button>
                  )}
                  {status === 'authenticated' && (
                    <span className="text-sm text-green-600 font-medium">Active</span>
                  )}
                  {status === 'logging_in' && (
                    <span className="text-sm text-yellow-600">In progress...</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Login modal */}
      {loginPlatform && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between p-4 border-b border-gray-200">
              <h3 className="font-semibold text-gray-900">
                Connect {PLATFORM_LABELS[loginPlatform] || loginPlatform}
              </h3>
              <button
                onClick={() => setLoginPlatform(null)}
                className="text-gray-400 hover:text-gray-600 text-xl leading-none"
              >
                &times;
              </button>
            </div>
            <div className="p-6">
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
