import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { searchRestaurants } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import AddressInput from './AddressInput';
import RestaurantCard from './RestaurantCard';

const CUISINE_OPTIONS = [
  'American', 'Chinese', 'Italian', 'Japanese', 'Korean', 'Mexican',
  'Thai', 'Indian', 'Mediterranean', 'Pizza', 'Burgers', 'Sushi',
  'Vietnamese', 'Seafood', 'Dessert', 'Breakfast', 'Healthy', 'Vegan',
];

const RADIUS_OPTIONS = [
  { label: '2 km', value: 2 },
  { label: '5 km', value: 5 },
  { label: '8 km', value: 8 },
  { label: '15 km', value: 15 },
  { label: '25 km', value: 25 },
];

export default function RestaurantSearch() {
  const navigate = useNavigate();
  const [address, setAddress] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [radius, setRadius] = useState(8);
  const setDeliveryAddress = useCartStore((s) => s.setDeliveryAddress);

  const { data, isLoading, error } = useQuery({
    queryKey: ['restaurants', address, nameQuery, cuisine, radius],
    queryFn: () => searchRestaurants(address, nameQuery || undefined, {
      radius,
      cuisine: cuisine || undefined,
    }),
    enabled: !!address,
  });

  useEffect(() => {
    if (data?.location) {
      setDeliveryAddress({
        lat: data.location.lat,
        lng: data.location.lng,
        address: data.location.formattedAddress || address,
      });
    }
  }, [data?.location?.lat, data?.location?.lng]);

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Hero */}
      <div>
        <h1 className="font-display text-4xl md:text-5xl text-text-primary tracking-tight italic">
          Find the best price
        </h1>
        <p className="text-text-secondary text-sm mt-2 max-w-md">
          Compare DoorDash and Seamless for every order. Same food, different prices.
        </p>
      </div>

      {/* Address */}
      <AddressInput onAddressSet={setAddress} />

      {/* Filters */}
      {address && (
        <div className="animate-fade-in space-y-3">
          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="Search by name..."
            className="w-full px-4 py-2.5 bg-surface border border-border-subtle rounded-sm text-sm transition-colors"
          />
          <div className="flex gap-3">
            <select
              value={cuisine}
              onChange={(e) => setCuisine(e.target.value)}
              className="flex-1 px-3 py-2 bg-surface border border-border-subtle rounded-sm text-sm text-text-secondary transition-colors"
            >
              <option value="">All cuisines</option>
              {CUISINE_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <select
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
              className="px-3 py-2 bg-surface border border-border-subtle rounded-sm text-sm text-text-secondary transition-colors"
            >
              {RADIUS_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-14 rounded-sm" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <p className="text-coral text-sm font-mono">Error searching. Try again.</p>
      )}

      {/* Results */}
      {data?.restaurants && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-xs font-mono text-text-muted tracking-wide uppercase">
              {data.restaurants.length} restaurants
            </span>
          </div>
          <div className="space-y-1 stagger">
            {data.restaurants.map((r) => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                onClick={() => navigate(`/restaurant/${r.id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
