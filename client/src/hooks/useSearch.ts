import { useQuery } from '@tanstack/react-query';
import { searchRestaurants } from '../api/client';

export function useSearch(address: string, query?: string) {
  return useQuery({
    queryKey: ['restaurants', address, query],
    queryFn: () => searchRestaurants(address, query),
    enabled: !!address,
  });
}
