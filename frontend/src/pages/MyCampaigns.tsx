import { useCampaignCapabilities } from '../context/CampaignCapabilities';
import { isMetadataOnly } from '../utils/campaignMode';
import { MetadataBanner } from '../components/MetadataBanner';
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchCampaigns, fetchCampaignSummary } from '../api/client';
import type { CampaignSummary } from '../types/campaign';
import { CampaignCard } from '../components/CampaignCard';
import { WalletConnectBar } from '../components/WalletConnectBar';
import { useWalletConnect } from '../wallet/useWalletConnect';
import { getCampaignRouteId } from '../utils/campaignRoute';

function normalizeAddress(value: string | undefined | null): string {
  if (!value) return '';
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.includes(':') ? trimmed : `ecash:${trimmed}`;
}

export const MyCampaigns: React.FC = () => {
  const { monetaryEnabled } = useCampaignCapabilities();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addresses } = useWalletConnect();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then((items) => {
        return Promise.all(items.map(async (campaign) => {
          const routeId = getCampaignRouteId(campaign);
          if (isMetadataOnly(campaign) || !monetaryEnabled || !routeId) {
            return { ...campaign, status: campaign.status || 'draft' } as CampaignSummary;
          }
          return fetchCampaignSummary(routeId);
        }));
      })
      .then(setCampaigns)
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'No se pudo cargar campañas.');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, [monetaryEnabled]);

  const normalizedWallet = useMemo(
    () => new Set(addresses.map((address) => normalizeAddress(address))),
    [addresses],
  );

  const filtered = campaigns.filter((campaign) => {
    if (isMetadataOnly(campaign)) return true;
    if (!monetaryEnabled || normalizedWallet.size === 0) return false;
    const payer = normalizeAddress(campaign.activation?.payerAddress || '');
    const beneficiary = normalizeAddress(campaign.beneficiaryAddress || '');
    return normalizedWallet.has(payer) || normalizedWallet.has(beneficiary);
  });

  return (
    <div>
      <Link to="/">Volver</Link>
      <h2>{monetaryEnabled ? 'Mis campañas' : 'Registros de metadata'}</h2>
      {monetaryEnabled ? <><WalletConnectBar />{!addresses.length && <p>Conecta tu wallet para filtrar campañas monetarias.</p>}</> : <><MetadataBanner /><p>Los registros no tienen dirección de propietario. Se muestran todos los registros disponibles.</p></>}
      {loading && <p>Cargando...</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      {!loading && !error && addresses.length > 0 && filtered.length === 0 && (
        <p>No hay campañas asociadas a tu dirección conectada.</p>
      )}
      {!loading && !error && !monetaryEnabled && filtered.length === 0 && <p>No hay registros de metadata.</p>}
      {filtered.map((campaign) => {
        const routeId = getCampaignRouteId(campaign);
        const fallbackKey = `${campaign.name}-${campaign.expiresAt}`;
        return <CampaignCard key={routeId ?? fallbackKey} campaign={campaign} />;
      })}
    </div>
  );
};
