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
    if (address.trim()) onAddressSet(address.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <div className="flex-1 relative">
        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted text-xs font-mono">
          LOC
        </span>
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Enter delivery address..."
          className="w-full pl-12 pr-4 py-3 bg-surface border border-border rounded-sm text-sm text-text-primary transition-colors"
        />
      </div>
      <button
        type="submit"
        className="px-6 py-3 bg-lime text-base font-semibold text-sm rounded-sm hover:bg-lime-dim transition-colors tracking-wide"
      >
        Search
      </button>
    </form>
  );
}
