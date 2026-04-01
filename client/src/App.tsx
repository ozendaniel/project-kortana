import { Routes, Route, useLocation } from 'react-router-dom';
import RestaurantSearch from './components/RestaurantSearch';
import MenuView from './components/MenuView';
import ComparisonView from './components/ComparisonView';
import SavingsDashboard from './components/SavingsDashboard';
import SettingsPage from './components/SettingsPage';
import AuthBanner from './components/AuthBanner';
import { useCartStore } from './stores/cartStore';

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const location = useLocation();
  const active = location.pathname === href;
  return (
    <a
      href={href}
      className={`text-sm tracking-wide transition-colors ${
        active ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {children}
    </a>
  );
}

export default function App() {
  const totalItems = useCartStore((s) => s.items.reduce((sum, i) => sum + i.quantity, 0));

  return (
    <div className="min-h-screen bg-base text-text-primary font-body">
      <header className="border-b border-border sticky top-0 z-40 bg-base/90 backdrop-blur-md">
        <div className="max-w-5xl mx-auto px-5 py-4 flex items-center justify-between">
          <a href="/" className="font-display text-2xl text-text-primary tracking-tight italic">
            Kortana
          </a>
          <nav className="flex items-center gap-6">
            <NavLink href="/">Search</NavLink>
            <NavLink href="/savings">Savings</NavLink>
            <NavLink href="/settings">Settings</NavLink>
            {totalItems > 0 && (
              <a
                href="/compare"
                className="flex items-center gap-1.5 text-sm font-mono font-medium text-lime bg-lime/10 px-3 py-1.5 rounded-sm border border-lime/20 hover:bg-lime/15 transition-colors"
              >
                <span>{totalItems}</span>
                <span className="text-xs text-lime/70">items</span>
              </a>
            )}
          </nav>
        </div>
      </header>

      <AuthBanner />

      <main className="max-w-5xl mx-auto px-5 py-8">
        <Routes>
          <Route path="/" element={<RestaurantSearch />} />
          <Route path="/restaurant/:id" element={<MenuView />} />
          <Route path="/compare" element={<ComparisonView />} />
          <Route path="/savings" element={<SavingsDashboard />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
