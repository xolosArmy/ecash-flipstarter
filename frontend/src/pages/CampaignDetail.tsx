import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchCampaignSummary } from '../api/client';
import type { CampaignSummary } from '../types/campaign';
import { PledgeForm } from '../components/PledgeForm';

export const CampaignDetail: React.FC = () => {
  const { id } = useParams();
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchCampaignSummary(id).then(setCampaign).catch(() => setCampaign(null));
  }, [id]);
  const refreshCampaign = () => {
    if (!id) return;
    fetchCampaignSummary(id).then(setCampaign).catch(() => setCampaign(null));
  };

  if (!id) return <p>Missing campaign id</p>;
  if (!campaign) return <p>Loading campaign...</p>;

  const percent =
    campaign.goal > 0
      ? Math.min(100, Math.round((campaign.totalPledged / campaign.goal) * 100))
      : 0;
  const statusLabel =
    campaign.status === 'active' ? 'Activo' : campaign.status === 'expired' ? 'Expirada' : 'Meta alcanzada';

  return (
    <div>
      <Link to="/">Back</Link>
      <h1>{campaign.name}</h1>
      <p>Estado: {statusLabel}</p>
      <p>
        Progreso: {campaign.totalPledged.toLocaleString()} / {campaign.goal.toLocaleString()} sats (
        {percent}%)
      </p>
      <progress max={100} value={percent} />
      <small>Expira el: {new Date(campaign.expiresAt).toLocaleDateString()}</small>
      {campaign.status === 'funded' && <p>Meta alcanzada. Gracias por tu apoyo.</p>}
      <PledgeForm campaignId={id} onBroadcastSuccess={refreshCampaign} />
    </div>
  );
};
