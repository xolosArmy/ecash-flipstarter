import React from 'react';
import type { CampaignSummary } from '../types/campaign';
import { Link } from 'react-router-dom';
import { AmountDisplay } from './AmountDisplay';
import { StatusBadge } from './StatusBadge';
import { Countdown } from './Countdown';

interface Props {
  campaign: CampaignSummary;
}

export const CampaignCard: React.FC<Props> = ({ campaign }) => {
  const campaignKey = campaign.id || campaign.slug;
  const detailUrl = campaignKey ? `/campaigns/${campaignKey}` : '#';

  const percent =
    campaign.goal > 0 ? Math.min(100, Math.round((campaign.totalPledged / campaign.goal) * 100)) : 0;
  const hasConfirmedActivation = Boolean(
    campaign.activation?.feeTxid
      && (campaign.status === 'active'
        || campaign.status === 'funded'
        || campaign.status === 'expired'
        || campaign.status === 'paid_out'),
  );
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h2>{campaign.name}</h2>
      <p>
        <AmountDisplay sats={campaign.totalPledged} /> / <AmountDisplay sats={campaign.goal} />
      </p>
      <progress value={percent} max={100} />
      <p>
        Estado: <StatusBadge status={campaign.status} />
      </p>
      <p>Tiempo restante: <Countdown expiresAt={campaign.expiresAt} /></p>
      {campaign.status === 'pending_fee' && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Pendiente de pago
        </p>
      )}
      {hasConfirmedActivation && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}>
          Activación confirmada
        </p>
      )}
      {campaignKey ? (
        <Link to={detailUrl}>Ver detalles</Link>
      ) : (
        <span style={{ opacity: 0.6 }}>Sin ID (registro inválido)</span>
      )}
    </div>
  );
};
