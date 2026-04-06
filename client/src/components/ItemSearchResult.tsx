import { useNavigate } from 'react-router-dom';

interface MatchingItem {
  id: string;
  name: string;
  description?: string;
  category: string;
  platforms: Record<string, { priceCents: number }>;
}

interface ItemSearchResultProps {
  restaurant: {
    id: string;
    name: string;
    address: string;
    platforms: Record<string, { available: boolean }>;
  };
  matchingItems: MatchingItem[];
  totalMatches: number;
  searchQuery: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function ItemSearchResult({ restaurant, matchingItems, totalMatches, searchQuery }: ItemSearchResultProps) {
  const navigate = useNavigate();
  const platforms = Object.keys(restaurant.platforms);
  const remaining = totalMatches - matchingItems.length;

  return (
    <div
      className="bg-surface border border-border-subtle rounded-sm transition-all hover:border-border cursor-pointer"
      onClick={() => navigate(`/restaurant/${restaurant.id}?q=${encodeURIComponent(searchQuery)}`)}
    >
      {/* Restaurant header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-border-subtle">
        {/* Platform dots */}
        <div className="flex flex-col gap-1.5">
          {platforms.map((p) => (
            <div
              key={p}
              className={`w-2 h-2 rounded-full ${p === 'doordash' ? 'bg-dd' : 'bg-sl'}`}
              title={p === 'doordash' ? 'DoorDash' : 'Seamless'}
            />
          ))}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-medium text-text-primary text-sm truncate">
            {restaurant.name}
          </h3>
          {restaurant.address && (
            <p className="text-xs text-text-muted mt-0.5 truncate">{restaurant.address}</p>
          )}
        </div>

        <span className="text-xs font-mono text-text-muted shrink-0">
          {totalMatches} {totalMatches === 1 ? 'match' : 'matches'}
        </span>

        <span className="text-text-muted text-xs">›</span>
      </div>

      {/* Matching items */}
      <div className="px-4 py-2">
        {matchingItems.map((item) => {
          const prices = Object.entries(item.platforms)
            .sort(([a], [b]) => (a === 'doordash' ? -1 : b === 'doordash' ? 1 : 0));

          return (
            <div key={item.id} className="flex items-center gap-2 py-1.5">
              <span className="text-sm text-text-secondary truncate flex-1 min-w-0">
                {item.name}
              </span>
              <span className="receipt-dots flex-shrink-0 w-8 border-b border-dotted border-border-subtle" />
              <div className="flex gap-2 shrink-0">
                {prices.map(([platform, info]) => (
                  <span
                    key={platform}
                    className={`text-xs font-mono font-medium ${
                      platform === 'doordash' ? 'text-dd' : 'text-sl'
                    }`}
                  >
                    {formatCents(info.priceCents)}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        {remaining > 0 && (
          <p className="text-xs text-text-muted font-mono py-1.5">
            +{remaining} more {remaining === 1 ? 'match' : 'matches'}
          </p>
        )}
      </div>
    </div>
  );
}
