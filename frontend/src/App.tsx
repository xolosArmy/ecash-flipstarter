import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { Home } from './pages/Home';
import { CampaignDetail } from './pages/CampaignDetail';
import { TonalliCallback } from './pages/TonalliCallback';

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
      <Route path="/campaigns/:id" element={<CampaignDetail />} />
      <Route path="/tonalli-callback" element={<TonalliCallback />} />
    </Routes>
  );
};

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: 16 }}>
        <AppRoutes />
      </div>
    </BrowserRouter>
  );
};
