import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getMenu } from '../api/client';
import { useCartStore } from '../stores/cartStore';
import CartPanel from './CartPanel';

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function MenuView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { addItem, setRestaurant, items } = useCartStore();

  const { data, isLoading, error } = useQuery({
    queryKey: ['menu', id],
    queryFn: () => getMenu(id!),
    enabled: !!id,
  });

  if (isLoading) return <p className="text-gray-400">Loading menu...</p>;
  if (error || !data) return <p className="text-red-500">Error loading menu.</p>;

  const { restaurant, menu } = data;

  // Set restaurant in cart on first load
  if (!items.length) {
    setRestaurant(restaurant.id, restaurant.name);
  }

  const handleAddItem = (item: { id: string; name: string; platforms: Record<string, { priceCents: number; available: boolean }> }) => {
    addItem({
      itemId: item.id,
      name: item.name,
      platforms: Object.fromEntries(
        Object.entries(item.platforms).map(([p, v]) => [p, { priceCents: v.priceCents, available: v.available }])
      ),
    });
  };

  return (
    <div className="flex gap-8">
      <div className="flex-1 space-y-6">
        <div>
          <button onClick={() => navigate('/')} className="text-sm text-blue-600 hover:underline mb-2">
            &larr; Back to search
          </button>
          <h1 className="text-2xl font-bold text-gray-900">{restaurant.name}</h1>
          <p className="text-sm text-gray-500">{restaurant.address}</p>
        </div>

        {menu.map((category) => (
          <div key={category.category}>
            <h2 className="text-lg font-semibold text-gray-800 mb-3 border-b pb-2">
              {category.category}
            </h2>
            <div className="space-y-3">
              {category.items.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between bg-white rounded-lg border border-gray-200 p-4"
                >
                  <div className="flex-1">
                    <h3 className="font-medium text-gray-900">{item.name}</h3>
                    {item.description && (
                      <p className="text-sm text-gray-400 mt-1 line-clamp-2">{item.description}</p>
                    )}
                    <div className="flex gap-4 mt-2 text-sm">
                      {Object.entries(item.platforms).map(([platform, info]) => (
                        <span
                          key={platform}
                          className={`font-medium ${
                            platform === 'doordash' ? 'text-red-600' : 'text-orange-600'
                          }`}
                        >
                          {platform === 'doordash' ? 'DD' : 'SL'}: {formatCents(info.priceCents)}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => handleAddItem({ id: item.id, name: item.name, platforms: item.platforms })}
                    className="ml-4 px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                  >
                    Add
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="w-80 flex-shrink-0">
        <CartPanel onCompare={() => navigate('/compare')} />
      </div>
    </div>
  );
}
