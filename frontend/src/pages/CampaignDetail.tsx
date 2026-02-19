import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  buildActivationTx,
  buildPayoutTx,
  confirmActivationTx,
  confirmPayoutTx,
  fetchCampaign,
  fetchCampaignActivationStatus,
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
import { getEcashAccounts, getPreferredEcashChain, WC_METHOD } from '../walletconnect/client';
import { extractWalletTxid } from '../walletconnect/txid';
import { shouldStopActivationPolling } from '../utils/activationPolling';

function normalizeEcashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':')) return trimmed;
  return `ecash:${trimmed}`;
}

function requireEcashChainId(session: unknown): string {
  const chainId = getPreferredEcashChain(session as any);
  if (!chainId) throw new Error('wc-no-chainid');
  return chainId;
}


export function resolveMutationCampaignId(
  slug: string,
  canonicalId: string | null,
  campaign: Pick<CampaignSummary, 'id'> | null,
): { ok: true; canonicalId: string } | { ok: false; error: string } {
  if (!canonicalId) {
    return { ok: false, error: 'No se pudo resolver el campaignId canónico desde la URL actual.' };
  }
  if (campaign?.id && campaign.id !== canonicalId) {
    return {
      ok: false,
      error: `Inconsistencia de campaña detectada (slug=${slug}, canonicalId=${canonicalId}, payload.id=${campaign.id}).`,
    };
  }
  return { ok: true, canonicalId };
}

export const CampaignDetail: React.FC = () => {
  const { id } = useParams();
  const routeCampaignId = String(id ?? '').trim();
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null);
  const [canonicalId, setCanonicalId] = useState<string | null>(null);
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
  const {
    signClient,
    topic,
    connected,
    connect,
    requestSignAndBroadcast,
    requestSignAndBroadcastRawTx,
    addresses,
  } = useWalletConnect();
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
    if (!routeCampaignId) return;
    setCampaignError('');
    fetchCampaign(routeCampaignId)
      .then((detail) => {
        const nextCanonicalId = detail.canonicalId || detail.id;
        setCanonicalId(nextCanonicalId);
        if (import.meta.env.DEV) console.debug(`[campaign] slug=${routeCampaignId} canonicalId=${nextCanonicalId}`);
        return fetchCampaignSummary(nextCanonicalId);
      })
      .then((summary) => setCampaign(summary))
      .catch(() => {
        setCampaign(null);
        setCampaignError('No se pudo cargar la campaña.');
      });
    const targetId = canonicalId || routeCampaignId;
    loadMessages(targetId);
    loadHistory(targetId);
  }, [canonicalId, routeCampaignId, loadHistory, loadMessages]);

  useEffect(() => {
    if (!routeCampaignId) {
      setLoadingCampaign(false);
      setCampaignError('');
      setCampaign(null);
      return;
    }
    setLoadingCampaign(true);
    setCampaignError('');
    fetchCampaign(routeCampaignId)
      .then((detail) => {
        const nextCanonicalId = detail.canonicalId || detail.id;
        setCanonicalId(nextCanonicalId);
        if (import.meta.env.DEV) console.debug(`[campaign] slug=${routeCampaignId} canonicalId=${nextCanonicalId}`);
        return fetchCampaignSummary(nextCanonicalId);
      })
      .then((summary) => {
        setCampaign(summary);
        setLoadingCampaign(false);
      })
      .catch(() => {
        setCampaign(null);
        setCampaignError('No se pudo cargar la campaña.');
        setLoadingCampaign(false);
      });
    const targetId = canonicalId || routeCampaignId;
    loadMessages(targetId);
    loadHistory(targetId);
  }, [canonicalId, routeCampaignId, loadHistory, loadMessages]);

  useEffect(() => {
    if (!routeCampaignId) return undefined;
    const onSummaryRefresh = (event: Event) => {
      const customEvent = event as CustomEvent<{ campaignId?: string; summary?: CampaignSummary }>;
      const eventCampaignId = customEvent.detail?.campaignId;
      if (eventCampaignId && eventCampaignId !== routeCampaignId && eventCampaignId !== canonicalId) return;
      if (customEvent.detail?.summary) {
        setCampaign(customEvent.detail.summary);
        setCampaignError('');
        return;
      }
      if (!canonicalId) return;
      fetchCampaignSummary(canonicalId)
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
  }, [canonicalId, routeCampaignId]);

  useEffect(() => {
    if (payerAddress.trim()) return;
    if (!addresses.length) return;
    setPayerAddress(normalizeEcashAddress(addresses[0]));
  }, [addresses, payerAddress]);

  useEffect(() => {
    if (!canonicalId) return undefined;
    if (campaign?.status !== 'pending_verification') return undefined;
    const txid = campaign.activationFeeTxid || campaign.activation?.feeTxid;
    if (!txid) return undefined;

    const interval = window.setInterval(async () => {
      try {
        const activation = await fetchCampaignActivationStatus(canonicalId);
        if (import.meta.env.DEV) {
          console.debug('[ActivationFee] polling status tick', activation);
        }
        if (activation.status === 'active') {
          const refreshed = await fetchCampaignSummary(canonicalId);
          setCampaign(refreshed);
          setActivationMessage('Pago verificado on-chain. Campaña activada.');
          window.dispatchEvent(
            new CustomEvent('campaign:summary:refresh', {
              detail: { campaignId: canonicalId, summary: refreshed },
            }),
          );
          window.dispatchEvent(new Event('campaigns:refresh'));
          window.clearInterval(interval);
          return;
        }
        if (shouldStopActivationPolling(activation)) {
          const refreshed = await fetchCampaignSummary(canonicalId);
          setCampaign(refreshed);
          setActivationError('Pago inválido (monto/dirección). Reintenta.');
          window.clearInterval(interval);
        }
      } catch {
        // Keep polling on transient failures.
      }
    }, 5000);

    return () => {
      window.clearInterval(interval);
    };
  }, [campaign?.activation?.feeTxid, campaign?.activationFeeTxid, campaign?.status, canonicalId]);

  const description = campaign?.description ?? '';
  const renderedDescription = useMemo(() => parseLimitedMarkdown(description), [description]);

  const activateCampaign = async () => {
    if (!routeCampaignId || activating) return;
    const idCheck = resolveMutationCampaignId(routeCampaignId, canonicalId, campaign);
    if (!idCheck.ok) {
      setActivationError(idCheck.error);
      return;
    }
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
        const account = getEcashAccounts(session ?? undefined)[0] || '';
        activeAddress = normalizeEcashAddress(account || activeAddress);
        activeSession = session;
      }

      if (!activeAddress) {
        throw new Error('payerAddress-required');
      }
      setPayerAddress(activeAddress);

      setActivationMessage('Construyendo pago de activación...');
      const built = await buildActivationTx(idCheck.canonicalId, activeAddress);
      localStorage.setItem(`tonalli:activationOfferId:${idCheck.canonicalId}`, built.wcOfferId);
      if (built.mode !== 'intent') {
        throw new Error('activation-mode-unsupported');
      }
      const ecashNs = activeSession?.namespaces?.ecash;
      if (!ecashNs) throw new Error('wc-no-ecash-namespace');
      const chainId = requireEcashChainId(activeSession);
      if (import.meta.env.DEV) {
        console.debug('[ActivationFee][WC] payload', {
          method: WC_METHOD,
          chainId,
          outputsCount: built.outputs.length,
          firstOutput: built.outputs[0] ?? null,
        });
      }

      setActivationMessage('Esperando confirmación en Tonalli...');
      const result = await requestSignAndBroadcast(built.wcOfferId, chainId, {
        outputs: built.outputs,
        userPrompt: built.userPrompt,
      });
      const txid = extractWalletTxid(result);
      if (!txid) {
        throw new Error('Tonalli returned an invalid txid.');
      }
      if (import.meta.env.DEV) {
        console.debug('[ActivationFee] broadcast txid', txid);
      }

      const summary = await confirmActivationTx(idCheck.canonicalId, txid, activeAddress);
      if (import.meta.env.DEV) {
        console.debug('[ActivationFee] confirm response', summary);
      }
      const refreshed = await fetchCampaignSummary(idCheck.canonicalId);
      setCampaign(refreshed);
      window.dispatchEvent(
        new CustomEvent('campaign:summary:refresh', {
          detail: { campaignId: idCheck.canonicalId, summary: refreshed },
        }),
      );
      window.dispatchEvent(new Event('campaigns:refresh'));
      const verificationStatus = summary.activationFeeVerificationStatus ?? summary.verificationStatus;
      if (verificationStatus === 'pending_verification') {
        setActivationMessage('Pago transmitido. Pendiente de confirmación on-chain (>=1 conf).');
        showToast('Pago transmitido. Pendiente de confirmación on-chain (>=1 conf).', 'info');
      } else if (verificationStatus === 'invalid') {
        setActivationError('Pago inválido (monto/dirección). Reintenta.');
        setActivationMessage('');
        showToast('Pago inválido. Reintenta.', 'error');
      } else {
        setActivationMessage('Fee pagada. Campaña activada.');
        showToast('Fee pagada. Campaña activada.', 'success');
      }
      refreshCampaign();
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
    if (!routeCampaignId || payingOut) return;
    const idCheck = resolveMutationCampaignId(routeCampaignId, canonicalId, campaign);
    if (!idCheck.ok) {
      setPayoutError(idCheck.error);
      return;
    }
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

      if (import.meta.env.DEV) console.debug(`[payout/build] using canonicalId=${idCheck.canonicalId} from slug=${routeCampaignId}`);
      const { unsignedTxHex, wcOfferId } = await buildPayoutTx(idCheck.canonicalId);
      setPayoutMessage('Esperando confirmación en Tonalli...');
      let txid: string | null = null;

      if (typeof unsignedTxHex === 'string' && unsignedTxHex.trim().length > 0) {
        const result = await requestSignAndBroadcastRawTx({
          offerId: wcOfferId,
          rawHex: unsignedTxHex,
          userPrompt: 'Payout campaign',
        });
        txid = result.txid;
      } else {
        console.warn('[Payout][WC] Missing unsignedTxHex, falling back to legacy WalletConnect request', {
          campaignId: idCheck.canonicalId,
          offerId: wcOfferId,
        });
        const ecashNs = activeSession?.namespaces?.ecash;
        if (!ecashNs) throw new Error('wc-no-ecash-namespace');
        const chainId = requireEcashChainId(activeSession);
        const result = await requestSignAndBroadcast(wcOfferId, chainId);
        txid = extractWalletTxid(result);
      }

      if (!txid) {
        throw new Error('Tonalli returned an invalid txid.');
      }
      const summary = await confirmPayoutTx(idCheck.canonicalId, txid);
      setCampaign(summary);
      window.dispatchEvent(
        new CustomEvent('campaign:summary:refresh', {
          detail: { campaignId: idCheck.canonicalId, summary },
        }),
      );
      window.dispatchEvent(new Event('campaigns:refresh'));
      setPayoutMessage(`Payout confirmado. Txid: ${txid}`);
      showToast('Payout confirmado on-chain', 'success');
      refreshCampaign();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'No se pudo finalizar el payout.';
      setPayoutError(message);
      showToast('No se pudo completar el payout', 'error');
    } finally {
      setPayingOut(false);
    }
  };

  if (!routeCampaignId) return <p>Missing campaign id</p>;
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
      {campaign.id !== (canonicalId || campaign.id) && (
        <p style={{ color: '#b00020' }}>Inconsistencia detectada entre URL y payload. Bloqueando acciones mutables.</p>
      )}
      {campaign.status === 'pending_fee' && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Pendiente de pago
        </p>
      )}
      {campaign.status === 'pending_verification' && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fef3c7', color: '#92400e' }}>
          Pago transmitido. Pendiente de confirmación on-chain (&gt;=1 conf)
        </p>
      )}
      {(campaign.status === 'fee_invalid'
        || (campaign.status === 'pending_fee' && campaign.activationFeeVerificationStatus === 'invalid')) && (
        <p style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: '#fee2e2', color: '#991b1b' }}>
          Pago inválido (monto/dirección). Reintenta
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
      {campaign.activationFeePaidAt && (
        <p>
          Fee pagada el: {new Date(campaign.activationFeePaidAt).toLocaleString()}
        </p>
      )}
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
      {(campaign.status === 'draft' || campaign.status === 'created' || campaign.status === 'pending_fee' || campaign.status === 'fee_invalid') && !activationFeePaid && (
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
        canonicalId ? (
          <PledgeForm
            campaignId={canonicalId}
            campaignAddress={campaign.covenant?.campaignAddress || campaign.campaignAddress}
            onBroadcastSuccess={refreshCampaign}
          />
        ) : (
          <p style={{ color: '#b00020' }}>No se pudo resolver el campaignId canónico. Refresca la página.</p>
        )
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
