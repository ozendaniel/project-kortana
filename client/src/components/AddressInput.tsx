import { useState, useEffect } from 'react';

interface AddressInputProps {
  onAddressSet: (address: string) => void;
}

export default function AddressInput({ onAddressSet }: AddressInputProps) {
  const [address, setAddress] = useState(() => localStorage.getItem('kortana_address') || '');

  useEffect(() => {
    if (address) localStorage.setItem('kortana_address', address);
  }, [address]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (address.trim()) {
      onAddressSet(address.trim());
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-3">
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Enter your delivery address..."
        className="flex-1 px-4 py-3 border border-gray-300 rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
      />
      <button
        type="submit"
        className="px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
      >
        Search
      </button>
    </form>
  );
}
