import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  confirmActivationTx,
  confirmLatestPendingPledgeTx,
  confirmPayoutTx,
  fetchCampaignActivationStatus,
  fetchCampaignSummary,
} from '../api/client';
import { useToast } from '../components/ToastProvider';

function getQueryParam(search: string, key: string): string | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return params.get(key);
}

function parseHashQuery(hash: string): URLSearchParams | null {
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  return new URLSearchParams(hash.slice(queryIndex + 1));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// Legacy flow (fallback)
export const TonalliCallback: React.FC = () => {
  const location = useLocation();
  const [txid, setTxid] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [mode, setMode] = useState<'pledge' | 'activate' | 'payout'>('pledge');
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    let cancelled = false;

    const searchTxid = getQueryParam(location.search, 'txid');
    const searchCampaignId = getQueryParam(location.search, 'campaignId');
    const hashParams = parseHashQuery(location.hash || '');
    const hashTxid = hashParams?.get('txid') || null;
    const hashCampaignId = hashParams?.get('campaignId') || null;
    const hashMode = hashParams?.get('mode') || null;
    const hashOfferId = hashParams?.get('wcOfferId') || null;

    const nextTxid = searchTxid || hashTxid;
    const nextCampaignId = searchCampaignId || hashCampaignId;
    const rawMode = getQueryParam(location.search, 'mode') || hashMode || 'pledge';
    const nextMode = rawMode === 'activate' || rawMode === 'payout' ? rawMode : 'pledge';
    const nextOfferId = getQueryParam(location.search, 'wcOfferId')
      || hashOfferId
      || (nextCampaignId ? localStorage.getItem(`tonalli:activationOfferId:${nextCampaignId}`) : null);

    setTxid(nextTxid);
    setCampaignId(nextCampaignId);
    setMode(nextMode);

    const confirmIfPossible = async () => {
      if (nextTxid && nextCampaignId) {
        setConfirming(true);
        setConfirmed(false);
        localStorage.setItem(`tonalli:txid:${nextCampaignId}`, nextTxid);
        const summary = nextMode === 'activate'
          ? await confirmActivationTx(nextCampaignId, nextTxid)
          : nextMode === 'payout'
            ? await confirmPayoutTx(nextCampaignId, nextTxid)
            : await (async () => {
                await confirmLatestPendingPledgeTx(nextCampaignId, nextTxid);
                localStorage.removeItem(`tonalli:pledgeId:${nextCampaignId}`);
                return fetchCampaignSummary(nextCampaignId);
              })();
        window.dispatchEvent(
          new CustomEvent('campaign:summary:refresh', {
            detail: { campaignId: nextCampaignId, summary },
          }),
        );
        window.dispatchEvent(new Event('campaigns:refresh'));
        if (!cancelled) {
          setError(null);
          setConfirmed(true);
          if (nextMode === 'activate') {
            showToast('Campaña activada');
          }
        }
        return;
      }

      if (!nextTxid && nextCampaignId && nextMode === 'activate' && nextOfferId) {
        setConfirming(true);
        for (let elapsed = 0; elapsed <= 60_000; elapsed += 3_000) {
          const statusResponse = await fetchCampaignActivationStatus(nextCampaignId, nextOfferId);
          if (statusResponse.feeTxid) {
            localStorage.setItem(`tonalli:txid:${nextCampaignId}`, statusResponse.feeTxid);
            const summary = await confirmActivationTx(nextCampaignId, statusResponse.feeTxid);
            window.dispatchEvent(
              new CustomEvent('campaign:summary:refresh', {
                detail: { campaignId: nextCampaignId, summary },
              }),
            );
            window.dispatchEvent(new Event('campaigns:refresh'));
            if (!cancelled) {
              setTxid(statusResponse.feeTxid);
              setError(null);
              setConfirmed(true);
              showToast('Campaña activada');
            }
            return;
          }
          if (statusResponse.status === 'active' || statusResponse.status === 'funded' || statusResponse.status === 'paid_out') {
            const summary = await fetchCampaignSummary(nextCampaignId);
            window.dispatchEvent(
              new CustomEvent('campaign:summary:refresh', {
                detail: { campaignId: nextCampaignId, summary },
              }),
            );
            window.dispatchEvent(new Event('campaigns:refresh'));
            if (!cancelled) {
              setError(null);
              setConfirmed(true);
              showToast('Campaña activada');
            }
            return;
          }
          await wait(3_000);
          if (cancelled) return;
        }
      }

      if (!cancelled) {
        if (!nextTxid) {
          setError('Missing txid in Tonalli callback.');
        } else if (!nextCampaignId) {
          setError('Missing campaignId in Tonalli callback.');
        }
      }
    };

    confirmIfPossible().catch((err: unknown) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : 'Failed to confirm pledge txid.';
      setError(message);
      setConfirmed(false);
    }).finally(() => {
      if (!cancelled) setConfirming(false);
    });

    return () => {
      cancelled = true;
    };
  }, [location.hash, location.search, showToast]);

  return (
    <div>
      <h2>Tonalli Callback</h2>
      {confirming && <p>Confirming {mode} on backend...</p>}
      {!confirming && confirmed && (
        <p>
          {mode === 'activate'
            ? 'Activation confirmed and campaign status refreshed.'
            : mode === 'payout'
              ? 'Payout confirmed and campaign status refreshed.'
            : 'Pledge confirmed and campaign totals refreshed.'}
        </p>
      )}
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
