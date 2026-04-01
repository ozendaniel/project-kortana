import type { Restaurant } from '../api/client';

interface RestaurantCardProps {
  restaurant: Restaurant;
  onClick: () => void;
}

export default function RestaurantCard({ restaurant, onClick }: RestaurantCardProps) {
  const platforms = Object.entries(restaurant.platforms).filter(([, v]) => v?.available);

  return (
    <div
      onClick={onClick}
      className="group flex items-center gap-4 px-4 py-3.5 bg-surface border border-border-subtle rounded-sm cursor-pointer hover:bg-surface-hover hover:border-border transition-all"
    >
      {/* Platform dots */}
      <div className="flex flex-col gap-1.5">
        {platforms.map(([p]) => (
          <div
            key={p}
            className={`w-2 h-2 rounded-full ${p === 'doordash' ? 'bg-dd' : 'bg-sl'}`}
            title={p === 'doordash' ? 'DoorDash' : 'Seamless'}
          />
        ))}
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="font-medium text-text-primary text-sm truncate group-hover:text-lime transition-colors">
            {restaurant.name}
          </h3>
          {platforms.length >= 2 && (
            <span className="shrink-0 text-[10px] font-mono font-medium text-lime/70 tracking-wider uppercase">
              2x
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          {restaurant.cuisines.length > 0 && (
            <span className="text-xs text-text-muted truncate">
              {restaurant.cuisines.slice(0, 3).join(' / ')}
            </span>
          )}
        </div>
      </div>

      {/* Platform tags */}
      <div className="flex gap-1.5 shrink-0">
        {platforms.map(([p, info]) => (
          <div
            key={p}
            className={`flex items-center gap-1 px-2 py-1 rounded-sm text-[10px] font-mono tracking-wide ${
              p === 'doordash'
                ? 'bg-dd-bg text-dd'
                : 'bg-sl-bg text-sl'
            }`}
          >
            <span>{p === 'doordash' ? 'DD' : 'SL'}</span>
            {info?.deliveryTime && (
              <span className="text-text-muted">{info.deliveryTime}</span>
            )}
          </div>
        ))}
      </div>

      {/* Arrow */}
      <span className="text-text-muted text-xs group-hover:text-text-secondary transition-colors">
        &rsaquo;
      </span>
    </div>
  );
}
