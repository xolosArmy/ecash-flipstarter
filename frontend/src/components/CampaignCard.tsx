import React from 'react';
import type { CampaignSummary } from '../api/types';
import { Link } from 'react-router-dom';

interface Props {
  campaign: CampaignSummary;
}

export const CampaignCard: React.FC<Props> = ({ campaign }) => {
  const goal = campaign.goal ? BigInt(campaign.goal) : 0n;
  const progress = typeof campaign.progress === 'number' ? campaign.progress : 0;
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <h3>{campaign.name}</h3>
      <p>Progress: {progress}%</p>
      <p>Goal: {goal.toString()} sat</p>
      <Link to={`/campaign/${campaign.id}`}>View details</Link>
    </div>
  );
};
