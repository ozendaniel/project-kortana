import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { searchRestaurants, searchMenuItems } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import AddressInput from './AddressInput';
import RestaurantCard from './RestaurantCard';
import ItemSearchResult from './ItemSearchResult';

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

type SearchMode = 'restaurants' | 'items';

export default function RestaurantSearch() {
  const navigate = useNavigate();
  const [address, setAddress] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('restaurants');
  const [cuisine, setCuisine] = useState('');
  const [radius, setRadius] = useState(8);
  const setDeliveryAddress = useCartStore((s) => s.setDeliveryAddress);

  // Debounced query for item search
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (searchMode === 'items') {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        setDebouncedQuery(nameQuery);
      }, 400);
      return () => clearTimeout(debounceTimer.current);
    } else {
      setDebouncedQuery(nameQuery);
    }
  }, [nameQuery, searchMode]);

  // Restaurant search query
  const restaurantQuery = useQuery({
    queryKey: ['restaurants', address, debouncedQuery, cuisine, radius],
    queryFn: () => searchRestaurants(address, debouncedQuery || undefined, {
      radius,
      cuisine: cuisine || undefined,
    }),
    enabled: !!address && searchMode === 'restaurants',
  });

  // Item search query
  const itemQuery = useQuery({
    queryKey: ['menuItems', address, debouncedQuery, cuisine, radius],
    queryFn: () => searchMenuItems(address, debouncedQuery, {
      radius,
      cuisine: cuisine || undefined,
    }),
    enabled: !!address && searchMode === 'items' && debouncedQuery.length >= 2,
  });

  const activeQuery = searchMode === 'restaurants' ? restaurantQuery : itemQuery;

  useEffect(() => {
    const loc = restaurantQuery.data?.location || itemQuery.data?.location;
    if (loc) {
      setDeliveryAddress({
        lat: loc.lat,
        lng: loc.lng,
        address: loc.formattedAddress || address,
      });
    }
  }, [restaurantQuery.data?.location?.lat, restaurantQuery.data?.location?.lng,
      itemQuery.data?.location?.lat, itemQuery.data?.location?.lng]);

  const handleModeSwitch = (mode: SearchMode) => {
    setSearchMode(mode);
    setNameQuery('');
    setDebouncedQuery('');
  };

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

      {/* Search mode toggle + filters */}
      {address && (
        <div className="animate-fade-in space-y-3">
          {/* Mode toggle */}
          <div className="flex gap-1 p-1 bg-surface border border-border-subtle rounded-sm w-fit">
            <button
              onClick={() => handleModeSwitch('restaurants')}
              className={`px-3 py-1.5 text-xs font-mono tracking-wide rounded-sm transition-colors ${
                searchMode === 'restaurants'
                  ? 'bg-lime/15 text-lime'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Restaurants
            </button>
            <button
              onClick={() => handleModeSwitch('items')}
              className={`px-3 py-1.5 text-xs font-mono tracking-wide rounded-sm transition-colors ${
                searchMode === 'items'
                  ? 'bg-lime/15 text-lime'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Menu Items
            </button>
          </div>

          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder={searchMode === 'restaurants' ? 'Search by name...' : 'Search for a dish...'}
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
      {activeQuery.isLoading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="skeleton h-14 rounded-sm" style={{ animationDelay: `${i * 100}ms` }} />
          ))}
        </div>
      )}

      {/* Error */}
      {activeQuery.error && (
        <p className="text-coral text-sm font-mono">Error searching. Try again.</p>
      )}

      {/* Item mode hint */}
      {searchMode === 'items' && address && debouncedQuery.length < 2 && !activeQuery.isLoading && (
        <p className="text-text-muted text-xs font-mono">Type at least 2 characters to search dishes</p>
      )}

      {/* Restaurant results */}
      {searchMode === 'restaurants' && restaurantQuery.data?.restaurants && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-xs font-mono text-text-muted tracking-wide uppercase">
              {restaurantQuery.data.restaurants.length} restaurants
            </span>
          </div>
          <div className="space-y-1 stagger">
            {restaurantQuery.data.restaurants.map((r) => (
              <RestaurantCard
                key={r.id}
                restaurant={r}
                onClick={(locationId) => navigate(`/restaurant/${locationId || r.id}`)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Item results */}
      {searchMode === 'items' && itemQuery.data?.results && (
        <div>
          <div className="flex items-baseline justify-between mb-3">
            <span className="text-xs font-mono text-text-muted tracking-wide uppercase">
              {itemQuery.data.totalItems} items across {itemQuery.data.results.length} restaurants
            </span>
          </div>
          <div className="space-y-1 stagger">
            {itemQuery.data.results.map((result) => (
              <ItemSearchResult
                key={result.restaurant.id}
                restaurant={result.restaurant}
                matchingItems={result.matchingItems}
                totalMatches={result.totalMatches}
                searchQuery={debouncedQuery}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
