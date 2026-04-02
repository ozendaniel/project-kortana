import { useState } from 'react';
import type { Restaurant } from '../api/client';

interface RestaurantCardProps {
  restaurant: Restaurant;
  onClick: (locationId?: string) => void;
}

export default function RestaurantCard({ restaurant, onClick }: RestaurantCardProps) {
  const platforms = Object.entries(restaurant.platforms).filter(([, v]) => v?.available);
  const locations = restaurant.locations?.filter((l) => l.address) || [];
  const isMultiLocation = locations.length > 1;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="bg-surface border border-border-subtle rounded-sm transition-all hover:border-border">
      {/* Main row — always visible */}
      <div
        onClick={() => isMultiLocation ? setExpanded(!expanded) : onClick()}
        className="group flex items-center gap-4 px-4 py-3.5 cursor-pointer"
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
            {isMultiLocation && (
              <span className="shrink-0 text-[10px] font-mono font-medium text-text-muted tracking-wider">
                {locations.length} locations
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {!isMultiLocation && locations[0]?.address && (
              <span className="text-xs text-text-muted truncate">
                {locations[0].address}
              </span>
            )}
            {(isMultiLocation || !locations[0]?.address) && restaurant.cuisines.length > 0 && (
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

        {/* Arrow / chevron */}
        <span className="text-text-muted text-xs group-hover:text-text-secondary transition-colors">
          {isMultiLocation ? (expanded ? '▾' : '▸') : '›'}
        </span>
      </div>

      {/* Expanded location list */}
      {isMultiLocation && expanded && (
        <div className="border-t border-border-subtle">
          {locations.map((loc) => (
            <div
              key={loc.id}
              onClick={() => onClick(loc.id)}
              className="flex items-center gap-4 px-4 py-2.5 cursor-pointer hover:bg-surface-hover transition-colors group/loc"
            >
              <div className="w-2" /> {/* spacer to align with dots */}
              <span className="flex-1 text-xs text-text-secondary group-hover/loc:text-text-primary transition-colors truncate">
                {loc.address}
              </span>
              <span className="text-text-muted text-xs group-hover/loc:text-text-secondary transition-colors">
                ›
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
