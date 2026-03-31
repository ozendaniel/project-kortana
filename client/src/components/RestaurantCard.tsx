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
      className="bg-white rounded-lg border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-gray-900">{restaurant.name}</h3>
          <p className="text-sm text-gray-500 mt-1">{restaurant.address}</p>
          {restaurant.cuisines.length > 0 && (
            <p className="text-sm text-gray-400 mt-1">{restaurant.cuisines.join(', ')}</p>
          )}
        </div>
      </div>

      <div className="flex gap-2 mt-3">
        {platforms.map(([platform]) => (
          <span
            key={platform}
            className={`text-xs font-medium px-2 py-1 rounded-full ${
              platform === 'doordash'
                ? 'bg-red-100 text-red-700'
                : platform === 'seamless'
                  ? 'bg-orange-100 text-orange-700'
                  : 'bg-green-100 text-green-700'
            }`}
          >
            {platform === 'doordash' ? 'DoorDash' : platform === 'seamless' ? 'Seamless' : 'Uber Eats'}
          </span>
        ))}
        {platforms.length >= 2 && (
          <span className="text-xs font-medium px-2 py-1 rounded-full bg-blue-100 text-blue-700">
            Compare prices
          </span>
        )}
      </div>
    </div>
  );
}
