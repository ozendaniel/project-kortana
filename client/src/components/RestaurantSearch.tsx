import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { searchRestaurants } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import AddressInput from './AddressInput';
import RestaurantCard from './RestaurantCard';

export default function RestaurantSearch() {
  const navigate = useNavigate();
  const [address, setAddress] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const setDeliveryAddress = useCartStore((s) => s.setDeliveryAddress);

  const { data: restaurants, isLoading, error } = useQuery({
    queryKey: ['restaurants', address, nameQuery],
    queryFn: () => searchRestaurants(address, nameQuery || undefined),
    enabled: !!address,
  });

  const handleAddressSet = (addr: string) => {
    setAddress(addr);
    // TODO: Geocode and store lat/lng in cart store
    setDeliveryAddress({ lat: 0, lng: 0, address: addr });
  };

  const handleRestaurantClick = (id: string) => {
    navigate(`/restaurant/${id}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Find the best price</h1>
        <p className="text-gray-500">Compare DoorDash and Seamless prices for your order</p>
      </div>

      <AddressInput onAddressSet={handleAddressSet} />

      {address && (
        <div>
          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="Filter by restaurant name..."
            className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {isLoading && <p className="text-gray-400">Searching restaurants...</p>}
      {error && <p className="text-red-500">Error searching restaurants. Try again.</p>}

      {restaurants && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">{restaurants.length} restaurants found</p>
          {restaurants.map((r) => (
            <RestaurantCard
              key={r.id}
              restaurant={r}
              onClick={() => handleRestaurantClick(r.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
