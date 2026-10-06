import { canUseMonetaryCampaign, isMetadataOnly } from '../utils/campaignMode';
import { useCampaignCapabilities } from '../context/CampaignCapabilities';
import React from 'react';
import type { CampaignSummary } from '../types/campaign';
import { Link } from 'react-router-dom';
import { AmountDisplay } from './AmountDisplay';
import { StatusBadge } from './StatusBadge';
import { Countdown } from './Countdown';
import { getCampaignRouteId } from '../utils/campaignRoute';

interface Props {
  campaign: CampaignSummary;
}

export const CampaignCard: React.FC<Props> = ({ campaign }) => {
  const { capabilities } = useCampaignCapabilities();
  const metadataOnly = isMetadataOnly(campaign);
  const monetaryAllowed = canUseMonetaryCampaign(campaign, capabilities);
  const numericGoal = monetaryAllowed ? Number(campaign.goal) : 0;
  const percent = numericGoal > 0 ? Math.min(100, Math.round(((campaign.totalPledged ?? 0) / numericGoal) * 100)) : 0;
  const routeId = getCampaignRouteId(campaign);
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
      {metadataOnly ? <><p><strong>Modo no monetario · solo metadata</strong></p><p>Meta propuesta: {String(campaign.goal)}</p></> : monetaryAllowed ? <>
        <p><AmountDisplay sats={campaign.totalPledged} /> / <AmountDisplay sats={campaign.goal} /></p>
        <progress value={percent} max={100} />
      </> : <p>Lectura de campaña · acciones monetarias deshabilitadas</p>}
      <p>
        Estado: <StatusBadge status={campaign.status} />
      </p>
      <p>Tiempo restante: <Countdown expiresAt={campaign.expiresAt} /></p>
      {monetaryAllowed && campaign.status === 'pending_fee' && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Pendiente de pago
        </p>
      )}
      {monetaryAllowed && hasConfirmedActivation && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534' }}>
          Activación confirmada
        </p>
      )}
      {routeId ? (
        <Link to={`/campaigns/${routeId}`}>Ver detalles</Link>
      ) : (
        <button type="button" disabled title="Campaña sin identificador de ruta">
          Ver detalles
        </button>
      )}
    </div>
  );
};
