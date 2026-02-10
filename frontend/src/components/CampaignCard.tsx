import React from 'react';
import type { CampaignSummary } from '../types/campaign';
import { Link } from 'react-router-dom';

interface Props {
  campaign: CampaignSummary;
}

export const CampaignCard: React.FC<Props> = ({ campaign }) => {
  const percent =
    campaign.goal > 0 ? Math.min(100, Math.round((campaign.totalPledged / campaign.goal) * 100)) : 0;
  const statusLabel = campaign.status === 'active'
    ? 'Activo'
    : campaign.status === 'pending_fee'
      ? 'Pendiente de activación'
      : campaign.status === 'draft'
        ? 'Borrador'
        : campaign.status === 'funded'
          ? 'Fondeada'
          : campaign.status === 'paid_out'
            ? 'Pagada'
            : 'Expirada';
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h2>{campaign.name}</h2>
      <p>
        {campaign.totalPledged.toLocaleString()} / {campaign.goal.toLocaleString()} sats
      </p>
      <progress value={percent} max={100} />
      <p>Estado: {statusLabel}</p>
      <Link to={`/campaigns/${campaign.id}`}>Ver detalles</Link>
    </div>
  );
};
