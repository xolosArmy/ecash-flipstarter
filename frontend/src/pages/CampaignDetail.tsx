import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  buildActivationTx,
  buildPayoutTx,
  confirmActivationTx,
  confirmPayoutTx,
  fetchCampaignSummary,
} from '../api/client';
import type { CampaignSummary } from '../types/campaign';
import { PledgeForm } from '../components/PledgeForm';
import { WalletConnectModal } from '../components/WalletConnectModal';
import { useWalletConnect } from '../wallet/useWalletConnect';

function normalizeEcashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':')) return trimmed;
  return `ecash:${trimmed}`;
}

function extractTxid(result: unknown): string | null {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && 'txid' in result) {
    const txid = (result as { txid?: unknown }).txid;
    return typeof txid === 'string' ? txid : null;
  }
  return null;
}

export const CampaignDetail: React.FC = () => {
  const { id } = useParams();
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null);
  const [payerAddress, setPayerAddress] = useState('');
  const [activationError, setActivationError] = useState('');
  const [activationMessage, setActivationMessage] = useState('');
  const [payoutError, setPayoutError] = useState('');
  const [payoutMessage, setPayoutMessage] = useState('');
  const [activating, setActivating] = useState(false);
  const [payingOut, setPayingOut] = useState(false);
  const { signClient, topic, connected, connect, requestSignAndBroadcast, addresses } = useWalletConnect();

  useEffect(() => {
    if (!id) return;
    fetchCampaignSummary(id).then(setCampaign).catch(() => setCampaign(null));
  }, [id]);

  useEffect(() => {
    if (!id) return undefined;
    const onSummaryRefresh = (event: Event) => {
      const customEvent = event as CustomEvent<{ campaignId?: string; summary?: CampaignSummary }>;
      if (customEvent.detail?.campaignId !== id) return;
      if (customEvent.detail?.summary) {
        setCampaign(customEvent.detail.summary);
        return;
      }
      fetchCampaignSummary(id).then(setCampaign).catch(() => setCampaign(null));
    };
    window.addEventListener('campaign:summary:refresh', onSummaryRefresh as EventListener);
    return () => {
      window.removeEventListener('campaign:summary:refresh', onSummaryRefresh as EventListener);
    };
  }, [id]);

  useEffect(() => {
    if (payerAddress.trim()) return;
    if (!addresses.length) return;
    setPayerAddress(normalizeEcashAddress(addresses[0]));
  }, [addresses, payerAddress]);

  const refreshCampaign = () => {
    if (!id) return;
    fetchCampaignSummary(id).then(setCampaign).catch(() => setCampaign(null));
  };

  const activateCampaign = async () => {
    if (!id || activating) return;
    setActivationError('');
    setActivationMessage('');
    setActivating(true);
    try {
      let activeAddress = normalizeEcashAddress(payerAddress);
      let activeSession: any = null;
      if (connected && signClient && topic) {
        try {
          activeSession = signClient.session.get(topic);
        } catch {
          activeSession = null;
        }
      }

      if (!connected) {
        const session = await connect();
        const account = session?.namespaces?.ecash?.accounts?.[0]?.split(':').slice(2).join(':') || '';
        activeAddress = normalizeEcashAddress(account || activeAddress);
        activeSession = session;
      }

      if (!activeAddress) {
        throw new Error('payerAddress-required');
      }
      setPayerAddress(activeAddress);

      setActivationMessage('Construyendo pago de activación...');
      const built = await buildActivationTx(id, activeAddress);
      const ecashNs = activeSession?.namespaces?.ecash;
      if (!ecashNs) throw new Error('wc-no-ecash-namespace');
      const chainId =
        (ecashNs.chains && ecashNs.chains[0]) ||
        (() => {
          const parts = ecashNs.accounts?.[0]?.split(':') ?? [];
          if (parts.length < 2) throw new Error('wc-no-chainid');
          return `${parts[0]}:${parts[1]}`;
        })();

      setActivationMessage('Esperando confirmación en Tonalli...');
      const result = await requestSignAndBroadcast(built.wcOfferId, chainId);
      const txid = extractTxid(result);
      if (!txid) {
        throw new Error('Tonalli returned an invalid txid.');
      }

      const summary = await confirmActivationTx(id, txid, activeAddress);
      setCampaign(summary);
      window.dispatchEvent(
        new CustomEvent('campaign:summary:refresh', {
          detail: { campaignId: id, summary },
        }),
      );
      window.dispatchEvent(new Event('campaigns:refresh'));
      setActivationMessage('Campaña activada.');
    } catch (err) {
      setActivationError(err instanceof Error ? err.message : 'No se pudo activar la campaña.');
    } finally {
      setActivating(false);
    }
  };

  const payoutCampaign = async () => {
    if (!id || payingOut) return;
    setPayoutError('');
    setPayoutMessage('');
    setPayingOut(true);
    try {
      let activeSession: any = null;
      if (connected && signClient && topic) {
        try {
          activeSession = signClient.session.get(topic);
        } catch {
          activeSession = null;
        }
      }
      if (!connected) {
        activeSession = await connect();
      }

      const built = await buildPayoutTx(id);
      const ecashNs = activeSession?.namespaces?.ecash;
      if (!ecashNs) throw new Error('wc-no-ecash-namespace');
      const chainId =
        (ecashNs.chains && ecashNs.chains[0]) ||
        (() => {
          const parts = ecashNs.accounts?.[0]?.split(':') ?? [];
          if (parts.length < 2) throw new Error('wc-no-chainid');
          return `${parts[0]}:${parts[1]}`;
        })();

      setPayoutMessage('Esperando confirmación en Tonalli...');
      const result = await requestSignAndBroadcast(built.wcOfferId, chainId);
      const txid = extractTxid(result);
      if (!txid) {
        throw new Error('Tonalli returned an invalid txid.');
      }
      const summary = await confirmPayoutTx(id, txid);
      setCampaign(summary);
      window.dispatchEvent(
        new CustomEvent('campaign:summary:refresh', {
          detail: { campaignId: id, summary },
        }),
      );
      window.dispatchEvent(new Event('campaigns:refresh'));
      setPayoutMessage('Payout confirmado.');
    } catch (err) {
      setPayoutError(err instanceof Error ? err.message : 'No se pudo finalizar el payout.');
    } finally {
      setPayingOut(false);
    }
  };

  if (!id) return <p>Missing campaign id</p>;
  if (!campaign) return <p>Loading campaign...</p>;

  const percent =
    campaign.goal > 0
      ? Math.min(100, Math.round((campaign.totalPledged / campaign.goal) * 100))
      : 0;
  const activationFeeSats = campaign.activation?.feeSats || '80000000';
  const statusLabel =
    campaign.status === 'draft'
      ? 'Borrador'
      : campaign.status === 'pending_fee'
        ? 'Pendiente de activación'
        : campaign.status === 'active'
          ? 'Activo'
          : campaign.status === 'expired'
            ? 'Expirada'
            : campaign.status === 'paid_out'
              ? 'Pagada'
              : 'Meta alcanzada';

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
      {(campaign.status === 'draft' || campaign.status === 'pending_fee') && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Activar campaña</h3>
          <p>
            Para activar la campaña debes pagar una tarifa de servicio de 800,000 XEC ({Number(activationFeeSats).toLocaleString()} sats). Esto activa
            la campaña en la red.
          </p>
          <label style={{ display: 'grid', gap: 4 }}>
            Payer Address
            <input
              value={payerAddress}
              onChange={(event) => setPayerAddress(event.target.value)}
              placeholder="ecash:..."
            />
          </label>
          <button type="button" onClick={activateCampaign} disabled={activating}>
            {activating ? 'Procesando...' : 'Construir pago de activación'}
          </button>
          {activationMessage && <p>{activationMessage}</p>}
          {activationError && <p style={{ color: '#b00020' }}>{activationError}</p>}
        </section>
      )}
      {campaign.status === 'funded' && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Finalizar / Payout</h3>
          <p>Al fondearse, 1% va a Tesorería Tonalli y 99% al beneficiario.</p>
          <button type="button" onClick={payoutCampaign} disabled={payingOut}>
            {payingOut ? 'Procesando...' : 'Construir payout'}
          </button>
          {payoutMessage && <p>{payoutMessage}</p>}
          {payoutError && <p style={{ color: '#b00020' }}>{payoutError}</p>}
        </section>
      )}
      {campaign.status === 'paid_out' && <p>Esta campaña ya fue pagada.</p>}
      <WalletConnectModal />
      {campaign.status === 'active' ? (
        <PledgeForm campaignId={id} onBroadcastSuccess={refreshCampaign} />
      ) : (
        <p>La campaña debe estar activa antes de aceptar pledges.</p>
      )}
    </div>
  );
};
