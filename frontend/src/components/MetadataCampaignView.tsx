import React from 'react';
import type { CampaignSummary } from '../types/campaign';
import { MetadataBanner } from './MetadataBanner';

const PLANNING_LABELS = {
  thesis: 'Tesis', milestones: 'Hitos', agentic: 'Planeación agéntica',
  administration: 'Administración', evidence: 'Evidencia', proposedPnL: 'PnL propuesto',
} as const;

export const MetadataCampaignView: React.FC<{ campaign: CampaignSummary }> = ({ campaign }) => (
  <section>
    <h1>{campaign.name}</h1>
    <MetadataBanner />
    <p>Estado del registro: {campaign.status === 'draft' ? 'Borrador' : campaign.status}</p>
    <p>Meta propuesta (dato de planificación): {String(campaign.goal)}</p>
    <p>Fecha propuesta: {new Date(campaign.expiresAt).toLocaleString()}</p>
    {campaign.description && <p style={{ whiteSpace: 'pre-wrap' }}>{campaign.description}</p>}
    {campaign.planning && Object.entries(PLANNING_LABELS).map(([key, label]) => {
      const value = campaign.planning?.[key as keyof typeof PLANNING_LABELS];
      if (value === undefined || value === null) return null;
      return <section key={key}><h3>{label}</h3><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{
        typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }</pre></section>;
    })}
  </section>
);
