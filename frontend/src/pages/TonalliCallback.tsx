import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

function getQueryParam(search: string, key: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get(key);
}

function parseHashQuery(hash: string): URLSearchParams | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1));
}

export const TonalliCallback: React.FC = () => {
  const location = useLocation();
  const [txid, setTxid] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const searchTxid = getQueryParam(location.search, 'txid');
    const searchCampaignId = getQueryParam(location.search, 'campaignId');
    const hashParams = parseHashQuery(location.hash || '');
    const hashTxid = hashParams?.get('txid') || null;
    const hashCampaignId = hashParams?.get('campaignId') || null;

    const nextTxid = searchTxid || hashTxid;
    const nextCampaignId = searchCampaignId || hashCampaignId;

    setTxid(nextTxid);
    setCampaignId(nextCampaignId);

    if (nextTxid && nextCampaignId) {
      localStorage.setItem(`tonalli:txid:${nextCampaignId}`, nextTxid);
      setError(null);
      return;
    }

    if (!nextTxid) {
      setError('Missing txid in Tonalli callback.');
    } else if (!nextCampaignId) {
      setError('Missing campaignId in Tonalli callback.');
    }
  }, [location.hash, location.search]);

  return (
    <div>
      <h2>Tonalli Callback</h2>
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      {txid && (
        <div>
          <p>Broadcast successful.</p>
          <p>TXID: {txid}</p>
          {campaignId && <p>Saved under campaign {campaignId}.</p>}
        </div>
      )}
      {campaignId ? (
        <Link to={`/campaigns/${campaignId}`}>Back to campaign</Link>
      ) : (
        <Link to="/">Back home</Link>
      )}
    </div>
  );
};
