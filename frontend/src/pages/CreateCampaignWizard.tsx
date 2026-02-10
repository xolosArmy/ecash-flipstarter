import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  buildCampaignActivationTx,
  confirmCampaignActivationTx,
  createCampaign,
  fetchCampaignSummary,
  type CreatedCampaign,
} from '../api/client';
import type { CampaignSummary } from '../types/campaign';
import { CopyToClipboardButton } from '../components/CopyToClipboardButton';
import { WalletConnectBar } from '../components/WalletConnectBar';
import { WalletConnectModal } from '../components/WalletConnectModal';
import { useWalletConnect } from '../wallet/useWalletConnect';

type WizardStep = 1 | 2 | 3;

const LAST_CAMPAIGN_ID_KEY = 'wizard:lastCreatedCampaignId';
const WIZARD_STEP_KEY = 'wizard:step';
const TXID_HEX_REGEX = /^[0-9a-f]{64}$/i;

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

function getChainIdFromSession(session: any): string {
  const ecashNs = session?.namespaces?.ecash;
  if (!ecashNs) throw new Error('wc-no-ecash-namespace');
  if (Array.isArray(ecashNs.chains) && ecashNs.chains.length > 0 && typeof ecashNs.chains[0] === 'string') {
    return ecashNs.chains[0];
  }
  const parts = typeof ecashNs.accounts?.[0] === 'string' ? ecashNs.accounts[0].split(':') : [];
  if (parts.length < 2) throw new Error('wc-no-chainid');
  return `${parts[0]}:${parts[1]}`;
}

function parseStoredStep(value: string | null): WizardStep | null {
  if (value === '1' || value === '2' || value === '3') {
    return Number(value) as WizardStep;
  }
  return null;
}

export const CreateCampaignWizard: React.FC = () => {
  const [step, setStep] = useState<WizardStep>(1);
  const [campaign, setCampaign] = useState<CampaignSummary | null>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [beneficiaryAddress, setBeneficiaryAddress] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');

  const [payerAddress, setPayerAddress] = useState('');
  const [txidInput, setTxidInput] = useState('');

  const [submittingCreate, setSubmittingCreate] = useState(false);
  const [payingActivation, setPayingActivation] = useState(false);
  const [confirmingActivation, setConfirmingActivation] = useState(false);
  const [loadingCampaign, setLoadingCampaign] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { signClient, topic, connected, connect, requestSignAndBroadcast, addresses } = useWalletConnect();

  const shareUrl = useMemo(() => {
    if (!campaignId) return '';
    return `${window.location.origin}/campaigns/${campaignId}`;
  }, [campaignId]);

  const setWizardStep = (nextStep: WizardStep) => {
    setStep(nextStep);
    localStorage.setItem(WIZARD_STEP_KEY, String(nextStep));
  };

  const persistCampaignId = (id: string) => {
    setCampaignId(id);
    localStorage.setItem(LAST_CAMPAIGN_ID_KEY, id);
  };

  const refreshCampaign = async (id: string) => {
    setLoadingCampaign(true);
    try {
      const summary = await fetchCampaignSummary(id);
      setCampaign(summary);
      if (summary.status === 'active') {
        setWizardStep(3);
      } else if (summary.status === 'pending_fee' || summary.status === 'draft') {
        setWizardStep(2);
      }
      return summary;
    } finally {
      setLoadingCampaign(false);
    }
  };

  useEffect(() => {
    const storedId = localStorage.getItem(LAST_CAMPAIGN_ID_KEY);
    const storedStep = parseStoredStep(localStorage.getItem(WIZARD_STEP_KEY));
    if (storedStep) {
      setStep(storedStep);
    }
    if (!storedId) return;
    persistCampaignId(storedId);
    refreshCampaign(storedId).catch(() => {
      localStorage.removeItem(LAST_CAMPAIGN_ID_KEY);
      localStorage.removeItem(WIZARD_STEP_KEY);
      setCampaignId(null);
      setCampaign(null);
      setStep(1);
    });
  }, []);

  useEffect(() => {
    if (payerAddress.trim()) return;
    if (!addresses.length) return;
    setPayerAddress(normalizeEcashAddress(addresses[0]));
  }, [addresses, payerAddress]);

  const handleCreatedCampaign = async (created: CreatedCampaign) => {
    persistCampaignId(created.id);
    setMessage('Borrador creado. Ahora activa la campaña para recibir donaciones.');
    setError(null);
    setWizardStep(2);
    await refreshCampaign(created.id);
    window.dispatchEvent(new Event('campaigns:refresh'));
  };

  const handleCreateSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    const trimmedName = name.trim();
    const numericGoal = Number(goal);
    const trimmedBeneficiary = beneficiaryAddress.trim();
    const trimmedExpiresAt = expiresAt.trim();
    if (trimmedName.length < 3) {
      setError('El nombre debe tener al menos 3 caracteres.');
      return;
    }
    if (!Number.isInteger(numericGoal) || numericGoal <= 0) {
      setError('La meta debe ser un entero positivo en sats.');
      return;
    }
    if (!trimmedExpiresAt) {
      setError('Selecciona una fecha de expiración.');
      return;
    }
    if (!trimmedBeneficiary) {
      setError('La dirección beneficiaria es obligatoria.');
      return;
    }

    setSubmittingCreate(true);
    try {
      const created = await createCampaign({
        name: trimmedName,
        goal: numericGoal,
        expiresAt: new Date(trimmedExpiresAt).toISOString(),
        beneficiaryAddress: trimmedBeneficiary,
        description: description.trim() || undefined,
        location: location.trim() || undefined,
      });
      await handleCreatedCampaign(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la campaña.');
    } finally {
      setSubmittingCreate(false);
    }
  };

  const confirmActivation = async (txid: string, activePayerAddress?: string) => {
    if (!campaignId) return;
    setConfirmingActivation(true);
    setError(null);
    setMessage('Confirmando activación...');
    try {
      const summary = await confirmCampaignActivationTx(campaignId, txid, activePayerAddress);
      setCampaign(summary);
      setTxidInput(txid);
      setWizardStep(summary.status === 'active' ? 3 : 2);
      setMessage(summary.status === 'active' ? 'Campaña activada ✅' : 'Activación confirmada.');
      window.dispatchEvent(
        new CustomEvent('campaign:summary:refresh', {
          detail: { campaignId, summary },
        }),
      );
      window.dispatchEvent(new Event('campaigns:refresh'));
      await refreshCampaign(campaignId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo confirmar la activación.');
      setMessage(null);
    } finally {
      setConfirmingActivation(false);
    }
  };

  const handlePayActivation = async () => {
    if (!campaignId || payingActivation) return;
    setPayingActivation(true);
    setError(null);
    setMessage('Preparando activación...');
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
      if (!connected || !activeSession) {
        activeSession = await connect();
      }
      if (!activeAddress) {
        const walletAddress = activeSession?.namespaces?.ecash?.accounts?.[0]?.split(':').slice(2).join(':');
        activeAddress = normalizeEcashAddress(walletAddress || '');
      }
      if (!activeAddress) {
        throw new Error('No se pudo detectar tu dirección pagadora.');
      }
      setPayerAddress(activeAddress);

      setMessage('Construyendo transacción de activación...');
      const built = await buildCampaignActivationTx(campaignId, activeAddress);
      const chainId = getChainIdFromSession(activeSession);

      setMessage('Activar campaña: revisa y firma en Tonalli.');
      const result = await requestSignAndBroadcast(built.wcOfferId, chainId);
      const txid = extractTxid(result);
      if (!txid) throw new Error('Tonalli no devolvió un txid válido.');

      await confirmActivation(txid, activeAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo pagar la activación.');
      setMessage(null);
    } finally {
      setPayingActivation(false);
    }
  };

  const handleManualConfirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const txid = txidInput.trim();
    if (!TXID_HEX_REGEX.test(txid)) {
      setError('Ingresa un txid válido de 64 caracteres hex.');
      return;
    }
    setError(null);
    await confirmActivation(txid, payerAddress.trim() || undefined);
  };

  const statusLabel = campaign?.status === 'active'
    ? 'Activo'
    : campaign?.status === 'pending_fee'
      ? 'Pendiente de activación'
      : campaign?.status === 'draft'
        ? 'Borrador'
        : campaign?.status === 'funded'
          ? 'Fondeada'
          : campaign?.status === 'paid_out'
            ? 'Pagada'
            : 'Expirada';
  const activationFeeSats = campaign?.activation?.feeSats ?? '80000000';

  return (
    <div>
      <Link to="/">Volver al inicio</Link>
      <h1>Crear campaña (guiado)</h1>
      <p>Crea tu campaña en 3 pasos para publicarla y empezar a recibir donaciones.</p>
      <p>
        <small>Solo cobramos 1% si la campaña se fondea completamente.</small>
      </p>
      <p>
        <small>Nunca escribas tu seed.</small>
      </p>
      <p>
        Paso {step} de 3
      </p>

      {step === 1 && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Paso 1: Datos de la campaña</h3>
          <form onSubmit={handleCreateSubmit} style={{ display: 'grid', gap: 10, maxWidth: 640 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              Nombre
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              Meta (sats)
              <input
                type="number"
                min={1}
                step={1}
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              Fecha de expiración
              <input
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              Dirección beneficiaria (ecash:...)
              <input
                value={beneficiaryAddress}
                onChange={(event) => setBeneficiaryAddress(event.target.value)}
                placeholder="ecash:..."
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              Descripción (opcional)
              <textarea
                rows={4}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              Ubicación (opcional)
              <input value={location} onChange={(event) => setLocation(event.target.value)} />
            </label>
            <button type="submit" disabled={submittingCreate}>
              {submittingCreate ? 'Creando...' : 'Crear borrador'}
            </button>
          </form>
        </section>
      )}

      {step >= 2 && campaignId && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Paso 2: Activar campaña</h3>
          <p>Estado actual: {statusLabel}</p>
          <p>
            Para activar tu campaña, paga la tarifa de activación: <strong>800,000 XEC</strong> (
            {Number(activationFeeSats).toLocaleString()} sats).
          </p>
          <WalletConnectBar />
          <label style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
            Dirección pagadora (opcional, se autocompleta al conectar)
            <input
              value={payerAddress}
              onChange={(event) => setPayerAddress(event.target.value)}
              placeholder="ecash:..."
            />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={handlePayActivation} disabled={payingActivation || confirmingActivation}>
              {payingActivation ? 'Procesando...' : 'Pagar tarifa de activación'}
            </button>
            <button
              type="button"
              onClick={() => refreshCampaign(campaignId)}
              disabled={loadingCampaign || payingActivation || confirmingActivation}
            >
              {loadingCampaign ? 'Actualizando...' : 'Actualizar estado'}
            </button>
          </div>
          <form onSubmit={handleManualConfirm} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              ¿Ya pagaste? Pega tu txid para confirmar
              <input
                value={txidInput}
                onChange={(event) => setTxidInput(event.target.value)}
                placeholder="txid de 64 caracteres hex"
              />
            </label>
            <button type="submit" disabled={confirmingActivation || payingActivation}>
              {confirmingActivation ? 'Confirmando...' : 'Confirmar activación'}
            </button>
          </form>
        </section>
      )}

      {step === 3 && campaignId && (
        <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginTop: 12 }}>
          <h3>Paso 3: Campaña activa</h3>
          <p>Campaña activada ✅</p>
          <p>Comparte tu campaña:</p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code>{shareUrl}</code>
            <CopyToClipboardButton text={shareUrl} idleLabel="Copiar enlace" />
          </div>
          <div style={{ marginTop: 12 }}>
            <Link to={`/campaigns/${campaignId}`}>Ir a la campaña</Link>
          </div>
        </section>
      )}

      {message && <p>{message}</p>}
      {error && <p style={{ color: '#b00020' }}>{error}</p>}
      <WalletConnectModal />
    </div>
  );
};
