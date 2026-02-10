import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, Link } from 'react-router-dom';
import { Home } from './pages/Home';
import { CampaignDetail } from './pages/CampaignDetail';
import { TonalliCallback } from './pages/TonalliCallback';
import { CreateCampaignWizard } from './pages/CreateCampaignWizard';
import { WalletConnectProvider } from './wallet/useWalletConnect';
import { SeedBanner } from './components/SeedBanner';
import { ToastProvider } from './components/ToastProvider';
import { MyCampaigns } from './pages/MyCampaigns';
import xolo from './assets/xolo.svg';

const AppRoutes: React.FC = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith('#/tonalli-callback')) return;
    const queryIndex = hash.indexOf('?');
    const search = queryIndex >= 0 ? hash.slice(queryIndex) : '';
    navigate(`/tonalli-callback${search}`, { replace: true });
  }, [navigate]);

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/campaigns/new" element={<CreateCampaignWizard />} />
      <Route path="/campaigns/create" element={<CreateCampaignWizard />} />
      <Route path="/campaigns/:id" element={<CampaignDetail />} />
      <Route path="/mis-campanas" element={<MyCampaigns />} />
      <Route path="/tonalli-callback" element={<TonalliCallback />} />
    </Routes>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <WalletConnectProvider>
        <ToastProvider>
          <div style={{ maxWidth: 920, margin: '0 auto', padding: 16 }} className="teyolia-shell">
            <header className="teyolia-header">
              <div className="teyolia-brand">
                <img src={xolo} alt="Xoloitzcuintle" width={120} height={68} />
                <div>
                  <h1>Teyolia</h1>
                  <small>Flipstarter 2.0</small>
                </div>
              </div>
              <nav className="teyolia-nav">
                <Link to="/">Inicio</Link>
                <Link to="/campaigns/create">Crear campaña</Link>
                <Link to="/mis-campanas">Mis campañas</Link>
              </nav>
            </header>
            <main className="teyolia-page">
              <AppRoutes />
            </main>
          </div>
          <SeedBanner />
        </ToastProvider>
      </WalletConnectProvider>
    </BrowserRouter>
  );
};
