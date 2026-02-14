import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  buildActivationTx,
  buildPayoutTx,
  confirmActivationTx,
  confirmPayoutTx,
  fetchCampaignHistory,
  fetchCampaignPledges,
  fetchCampaignSummary,
} from '../api/client';
import type { AuditLog } from '../api/types';
import type { CampaignSummary } from '../types/campaign';
import { PledgeForm } from '../components/PledgeForm';
import { WalletConnectModal } from '../components/WalletConnectModal';
import { useWalletConnect } from '../wallet/useWalletConnect';
import { useToast } from '../components/ToastProvider';
import { parseLimitedMarkdown } from '../utils/markdown';
import { AmountDisplay } from '../components/AmountDisplay';
import { ExplorerLink } from '../components/ExplorerLink';
import { StatusBadge } from '../components/StatusBadge';
import { SecurityBanner } from '../components/SecurityBanner';
import { Countdown } from '../components/Countdown';
import { WC_METHOD } from '../walletconnect/client';

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
  const [loadingCampaign, setLoadingCampaign] = useState(true);
  const [campaignError, setCampaignError] = useState('');
  const [payerAddress, setPayerAddress] = useState('');
  const [activationError, setActivationError] = useState('');
  const [activationMessage, setActivationMessage] = useState('');
  const [payoutError, setPayoutError] = useState('');
  const [payoutMessage, setPayoutMessage] = useState('');
  const [activating, setActivating] = useState(false);
  const [payingOut, setPayingOut] = useState(false);
  const [messages, setMessages] = useState<Array<{ amount: number; timestamp: string; message: string }>>([]);
  const [history, setHistory] = useState<AuditLog[]>([]);
  const { signClient, topic, connected, connect, requestSignAndBroadcast, addresses } = useWalletConnect();
  const { showToast } = useToast();

  const loadMessages = useCallback((campaignId: string) => {
    fetchCampaignPledges(campaignId)
      .then((response) => {
        const nextMessages = response.pledges
          .filter((pledge) => typeof pledge.message === 'string' && pledge.message.trim())
          .map((pledge) => ({
            amount: pledge.amount,
            timestamp: pledge.timestamp,
            message: pledge.message!.trim(),
          }))
          .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
          .slice(0, 20);
        setMessages(nextMessages);
      })
      .catch(() => setMessages([]));
  }, []);

  const loadHistory = useCallback((campaignId: string) => {
    fetchCampaignHistory(campaignId)
      .then((logs) => {
        const sorted = [...logs].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        setHistory(sorted);
      })
      .catch(() => setHistory([]));
  }, []);

  const refreshCampaign = useCallback(() => {
    if (!id) return;
    setCampaignError('');
    fetchCampaignSummary(id)
      .then((summary) => setCampaign(summary))
      .catch(() => {
        setCampaign(null);
        setCampaignError('No se pudo cargar la campaña.');
      });
    loadMessages(id);
    loadHistory(id);
  }, [id, loadHistory, loadMessages]);

  useEffect(() => {
    if (!id) {
      setLoadingCampaign(false);
      setCampaignError('');
      setCampaign(null);
      return;
    }
    setLoadingCampaign(true);
    setCampaignError('');
    fetchCampaignSummary(id)
      .then((summary) => {
        setCampaign(summary);
        setLoadingCampaign(false);
      })
      .catch(() => {
        setCampaign(null);
        setCampaignError('No se pudo cargar la campaña.');
        setLoadingCampaign(false);
      });
    loadMessages(id);
    loadHistory(id);
  }, [id, loadHistory, loadMessages]);

  useEffect(() => {
    if (!id) return undefined;
    const onSummaryRefresh = (event: Event) => {
      const customEvent = event as CustomEvent<{ campaignId?: string; summary?: CampaignSummary }>;
      if (customEvent.detail?.campaignId !== id) return;
      if (customEvent.detail?.summary) {
        setCampaign(customEvent.detail.summary);
        setCampaignError('');
        return;
      }
      fetchCampaignSummary(id)
        .then((summary) => {
          setCampaign(summary);
          setCampaignError('');
        })
        .catch(() => {
          setCampaign(null);
          setCampaignError('No se pudo cargar la campaña.');
        });
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

  const description = campaign?.description ?? '';
  const renderedDescription = useMemo(() => parseLimitedMarkdown(description), [description]);

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
      localStorage.setItem(`tonalli:activationOfferId:${id}`, built.wcOfferId);
      if (built.mode !== 'intent') {
        throw new Error('activation-mode-unsupported');
      }
      const ecashNs = activeSession?.namespaces?.ecash;
      if (!ecashNs) throw new Error('wc-no-ecash-namespace');
      const chainId =
        (ecashNs.chains && ecashNs.chains[0]) ||
        (() => {
          const parts = ecashNs.accounts?.[0]?.split(':') ?? [];
          if (parts.length < 2) throw new Error('wc-no-chainid');
          return `${parts[0]}:${parts[1]}`;
        })();
      console.debug('[ActivationFee][WC] payload', {
        method: WC_METHOD,
        chainId,
        outputsCount: built.outputs.length,
        firstOutput: built.outputs[0] ?? null,
      });

      setActivationMessage('Esperando confirmación en Tonalli...');
      const result = await requestSignAndBroadcast(built.wcOfferId, chainId, {
        outputs: built.outputs,
        userPrompt: built.userPrompt,
      });
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
      if (summary.verificationStatus === 'pending_verification') {
        setActivationMessage(`No se pudo verificar en Chronik, pero guardamos tu txid: ${txid}`);
      } else {
        setActivationMessage('Campaña activada.');
      }
      showToast('Campaña activada on-chain', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo activar la campaña.';
      const lower = message.toLowerCase();
      if (lower.includes('insufficient') || lower.includes('funds')) {
        setActivationError('Fondos insuficientes para pagar fee + comisión');
      } else if (lower.includes('fee too low') || lower.includes('mempool')) {
        setActivationError('Transacción rechazada por mempool (fee demasiado baja)');
      } else if (message.includes('activation-mode-unsupported')) {
        setActivationError('El backend devolvió un modo de activación no soportado.');
      } else {
        setActivationError(message);
      }
      showToast('No se pudo activar la campaña', 'error');
    } finally {
      setActivating(false);
    }
  };

  const payoutCampaign = async () => {
    if (!id || payingOut) return;
    setPayoutError('');
    setPayoutMessage('');
    setPayingOut(true);
    showToast('Construyendo payout...', 'info');
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
      showToast('Payout confirmado on-chain', 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo finalizar el payout.';
      setPayoutError(message);
      showToast('No se pudo completar el payout', 'error');
    } finally {
      setPayingOut(false);
    }
  };

  if (!id) return <p>Missing campaign id</p>;
  if (loadingCampaign) return <p>Loading campaign...</p>;
  if (campaignError) return <p>{campaignError}</p>;
  if (!campaign) return <p>Campaign not found.</p>;

  const percent =
    campaign.goal > 0
      ? Math.min(100, Math.round((campaign.totalPledged / campaign.goal) * 100))
      : 0;
  const activationFeeSats = campaign.activation?.feeSats || '80000000';
  const activationFeeTxid = campaign.activationFeeTxid || campaign.activation?.feeTxid || null;
  const activationFeePaid = campaign.activationFeePaid ?? Boolean(activationFeeTxid);
  const activationFeeRequiredXec = (() => {
    if (typeof campaign.activationFeeRequired === 'number' && Number.isFinite(campaign.activationFeeRequired)) {
      return campaign.activationFeeRequired;
    }
    const parsedSats = Number(activationFeeSats);
    if (Number.isFinite(parsedSats) && parsedSats > 0) {
      return Math.floor(parsedSats / 100);
    }
    return 800000;
  })();
  const payoutTxid = campaign.payout?.txid || null;
  const hasConfirmedActivation = Boolean(
    activationFeePaid
      && (campaign.status === 'active'
        || campaign.status === 'funded'
        || campaign.status === 'expired'
        || campaign.status === 'paid_out'),
  );

  return (
    <div>
      <Link to="/">Back</Link>
      <h1>{campaign.name}</h1>
      <SecurityBanner />
      <p>Estado: <StatusBadge status={campaign.status} /></p>
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
      <p>
        Fee de activación: {new Intl.NumberFormat('es-MX').format(activationFeeRequiredXec)} XEC
        {' · '}
        Estado: {activationFeePaid ? 'Pagada' : 'Pendiente'}
      </p>
      <p>
        Progreso: <AmountDisplay sats={campaign.totalPledged} /> / <AmountDisplay sats={campaign.goal} /> ({percent}%)
      </p>
      {campaign.description && (
        <section style={{ marginBottom: 12 }}>
          <h3>Descripción</h3>
          <p dangerouslySetInnerHTML={{ __html: renderedDescription.html }} />
          {renderedDescription.imageLinks.map((link) => (
            <img
              key={link}
              src={link}
              alt="Preview de campaña"
              style={{ maxWidth: '100%', borderRadius: 8, border: '1px solid #2d3f42', marginTop: 8 }}
            />
          ))}
          {renderedDescription.youtubeLinks.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <strong>Links de YouTube</strong>
              {renderedDescription.youtubeLinks.map((link) => (
                <p key={link} style={{ margin: '6px 0 0' }}>
                  <a href={link} target="_blank" rel="noreferrer">Video: {link}</a>
                </p>
              ))}
            </div>
          )}
        </section>
      )}
      <progress max={100} value={percent} />
      <small>
        Expira el: {new Date(campaign.expiresAt).toLocaleDateString()} (<Countdown expiresAt={campaign.expiresAt} />)
      </small>
      {activationFeeTxid && (
        <p>
          Tx de activación: <ExplorerLink txid={activationFeeTxid} />
        </p>
      )}
      {payoutTxid && (
        <p>
          Tx de payout: <ExplorerLink txid={payoutTxid} />
        </p>
      )}
      {campaign.status === 'funded' && <p>Meta alcanzada. Gracias por tu apoyo.</p>}
      {(campaign.status === 'draft' || campaign.status === 'pending_fee') && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Activar campaña</h3>
          <p>
            Para activar la campaña debes pagar la fee de activación de{' '}
            {new Intl.NumberFormat('es-MX').format(activationFeeRequiredXec)} XEC.
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
            {activating ? 'Procesando...' : 'Pagar fee de activación'}
          </button>
          {activationMessage && <p>{activationMessage}</p>}
          {activationError && <p style={{ color: '#b00020' }}>{activationError}</p>}
        </section>
      )}
      {campaign.status === 'funded' && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Finalizar / Payout</h3>
          <p>
            Al fondearse, 1% va a Tesorería Tonalli y 99% al beneficiario.
            {' '}
            <small title="El 1% se destina al mantenimiento de la infraestructura de Teyolia solo si la campaña tiene éxito">
              (?)
            </small>
          </p>
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
      <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
        <h3>Mensajes</h3>
        {messages.length === 0 && <p>No hay mensajes todavía.</p>}
        {messages.map((item, index) => (
          <article key={`${item.timestamp}-${index}`} style={{ padding: '8px 0', borderBottom: '1px solid #f2f2f2' }}>
            <p style={{ margin: 0 }}>{item.message}</p>
            <small>
              {new Date(item.timestamp).toLocaleString()}
              {' · '}
              <AmountDisplay sats={item.amount} />
            </small>
          </article>
        ))}
      </section>
      <section className="teyolia-audit-section">
        <h3>Historial de Auditoría</h3>
        <div className="audit-timeline">
          {history.length === 0 && <p>No hay eventos de auditoría todavía.</p>}
          {history.map((log, index) => (
            <div key={`${log.timestamp}-${index}`} className="audit-event">
              <div className="audit-dot" />
              <div className="audit-content">
                <header>
                  <span className={`audit-badge badge-${log.event.toLowerCase()}`}>
                    {log.event}
                  </span>
                  <time>{new Date(log.timestamp).toLocaleString()}</time>
                </header>
                <pre className="audit-details">
                  {log.event === 'PLEDGE_RECEIVED'
                    ? `Donación de ${String(log.details?.amount ?? '')} sats`
                    : `Estado cambiado a ${log.event}`}
                </pre>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
