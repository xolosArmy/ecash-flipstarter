import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCampaigns } from '../api/client';
import type { CampaignSummary } from '../api/types';
import { CampaignCard } from '../components/CampaignCard';

export const Home: React.FC = () => {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const navigate = useNavigate();

  const loadCampaigns = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then((data) => setCampaigns(data))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load campaigns');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  const openCampaign = () => {
    const trimmed = campaignId.trim();
    if (!trimmed) return;
    navigate(`/campaign/${trimmed}`);
  };

  return (
    <div>
      <h2>Flipstarter 2.0 Campaigns</h2>
      <div style={{ marginBottom: 16 }}>
        <button type="button" onClick={loadCampaigns} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        {error && (
          <p style={{ color: '#b00020', marginTop: 8 }}>
            Error: {error}
          </p>
        )}
      </div>
      <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <h3>Open campaign by ID</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={campaignId}
            onChange={(event) => setCampaignId(event.target.value)}
            placeholder="campaign-id"
            style={{ flex: 1, padding: 8 }}
          />
          <button type="button" onClick={openCampaign}>
            Open
          </button>
        </div>
      </div>
      {!loading && campaigns.length === 0 && !error && <p>No campaigns found.</p>}
      {campaigns.map((c) => (
        <CampaignCard key={c.id} campaign={c} />
      ))}
    </div>
  );
};
