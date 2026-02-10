import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCampaigns, fetchCampaignSummary } from '../api/client';
import type { CampaignSummary } from '../types/campaign';
import { CampaignCard } from '../components/CampaignCard';
import { WalletConnectBar } from '../components/WalletConnectBar';
import { useWalletConnect } from '../wallet/useWalletConnect';

function normalizeAddress(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.includes(':') ? trimmed : `ecash:${trimmed}`;
}

export const MyCampaigns: React.FC = () => {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addresses } = useWalletConnect();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then((items) => Promise.all(items.map((item) => fetchCampaignSummary(item.id))))
      .then(setCampaigns)
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'No se pudo cargar campañas.');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const normalizedWallet = useMemo(
    () => new Set(addresses.map((address) => normalizeAddress(address))),
    [addresses],
  );

  const filtered = campaigns.filter((campaign) => {
    if (normalizedWallet.size === 0) return false;
    const payer = normalizeAddress(campaign.activation?.payerAddress || '');
    const beneficiary = normalizeAddress(campaign.beneficiaryAddress || '');
    return normalizedWallet.has(payer) || normalizedWallet.has(beneficiary);
  });

  return (
    <div>
      <Link to="/">Volver</Link>
      <h2>Mis campañas</h2>
      <WalletConnectBar />
      {!addresses.length && <p>Conecta tu wallet para filtrar campañas.</p>}
      {loading && <p>Cargando...</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      {!loading && !error && addresses.length > 0 && filtered.length === 0 && (
        <p>No hay campañas asociadas a tu dirección conectada.</p>
      )}
      {filtered.map((campaign) => (
        <CampaignCard key={campaign.id} campaign={campaign} />
      ))}
    </div>
  );
};
