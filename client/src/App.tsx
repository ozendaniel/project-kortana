import { Routes, Route } from 'react-router-dom';
import RestaurantSearch from './components/RestaurantSearch';
import MenuView from './components/MenuView';
import ComparisonView from './components/ComparisonView';
import SavingsDashboard from './components/SavingsDashboard';
import SettingsPage from './components/SettingsPage';
import AuthBanner from './components/AuthBanner';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <a href="/" className="text-xl font-bold text-gray-900">
            Kortana
          </a>
          <nav className="flex gap-6 text-sm">
            <a href="/" className="text-gray-600 hover:text-gray-900">Search</a>
            <a href="/savings" className="text-gray-600 hover:text-gray-900">Savings</a>
            <a href="/settings" className="text-gray-600 hover:text-gray-900">Settings</a>
          </nav>
        </div>
      </header>

      <AuthBanner />

      <main className="max-w-6xl mx-auto px-6 py-8">
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
