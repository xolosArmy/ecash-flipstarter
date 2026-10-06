import { useCampaignCapabilities } from '../context/CampaignCapabilities';
import { isMetadataOnly } from '../utils/campaignMode';
import { MetadataBanner } from '../components/MetadataBanner';
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createCampaign, fetchCampaigns, fetchCampaignSummary, fetchGlobalStats } from '../api/client';
import { AmountDisplay } from '../components/AmountDisplay';
import type { GlobalStats } from '../api/types';
import type { CampaignSummary as CampaignSummaryResponse } from '../types/campaign';
import { CampaignCard } from '../components/CampaignCard';
import { WalletConnectBar } from '../components/WalletConnectBar';
import { SecurityBanner } from '../components/SecurityBanner';
import { parseXecInputToSats } from '../utils/amount';
import { getCampaignRouteId } from '../utils/campaignRoute';
import { useWalletConnect } from '../wallet/useWalletConnect';
import {
  RECIPIENT_ADDRESS_MISMATCH_LABEL,
  ecashAddressFromPublicKey,
  recipientAddressMatchesPublicKey,
  resolveTonalliBeneficiaryPubKey,
} from '../wallet/ecashPublicKey';

export const Home: React.FC = () => {
  const { monetaryEnabled } = useCampaignCapabilities();
  const [campaigns, setCampaigns] = useState<CampaignSummaryResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [filterStatus, setFilterStatus] = useState('Todas');
  const [sortBy, setSortBy] = useState('Recaudación');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [recipientAddress, setRecipientAddress] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const navigate = useNavigate();
  const { publicKey, connect, resetSession, requestAccountPublicKey } = useWalletConnect();

  const loadCampaigns = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then((data) => {
        return Promise.all(data.map(async (campaign) => {
          const routeId = getCampaignRouteId(campaign);
          if (isMetadataOnly(campaign) || !monetaryEnabled || !routeId) {
            return { ...campaign, status: campaign.status || 'draft' } as CampaignSummaryResponse;
          }
          return fetchCampaignSummary(routeId);
        }));
      })
      .then((summaries) => setCampaigns(summaries))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load campaigns');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, [monetaryEnabled]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (!publicKey) return;
    let derived = '';
    try {
      derived = ecashAddressFromPublicKey(publicKey);
    } catch {
      return;
    }
    setRecipientAddress((current) => (current.trim() ? current : derived));
  }, [publicKey]);

  useEffect(() => {
    if (monetaryEnabled) fetchGlobalStats().then(setGlobalStats).catch(console.error);
    else setGlobalStats(null);
  }, [monetaryEnabled]);

  useEffect(() => {
    const onCampaignRefresh = () => loadCampaigns();
    window.addEventListener('campaigns:refresh', onCampaignRefresh);
    return () => {
      window.removeEventListener('campaigns:refresh', onCampaignRefresh);
    };
  }, [loadCampaigns]);

  const openCampaign = () => {
    const trimmed = campaignId.trim();
    if (!trimmed) return;
    navigate(`/campaigns/${trimmed}`);
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setRecipientAddress('');
    setGoal('');
    setExpiresAt('');
  };

  const handleCreateSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!monetaryEnabled) return;
    setFormMessage(null);

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedRecipientAddress = recipientAddress.trim();
    const parsedGoal = parseXecInputToSats(goal);
    const trimmedExpiresAt = expiresAt.trim();

    if (!trimmedName || !trimmedDescription || !trimmedExpiresAt) {
      setFormMessage('Completa todos los campos.');
      return;
    }
    if (
      publicKey
      && trimmedRecipientAddress
      && !recipientAddressMatchesPublicKey(trimmedRecipientAddress, publicKey)
    ) {
      setFormMessage(RECIPIENT_ADDRESS_MISMATCH_LABEL);
      return;
    }
    if (parsedGoal.error) {
      setFormMessage(parsedGoal.error);
      return;
    }
    if (parsedGoal.sats === null || parsedGoal.sats <= 0) {
      setFormMessage('La meta debe ser mayor que cero.');
      return;
    }

    let expiresAtIso = '';
    try {
      expiresAtIso = new Date(trimmedExpiresAt).toISOString();
    } catch {
      setFormMessage('Fecha de expiración inválida.');
      return;
    }

    setCreating(true);
    try {
      const beneficiaryPubKey = await resolveTonalliBeneficiaryPubKey({
        publicKey,
        connect,
        resetSession,
        requestAccountPublicKey,
      });
      const derivedRecipient = ecashAddressFromPublicKey(beneficiaryPubKey);
      if (trimmedRecipientAddress && !recipientAddressMatchesPublicKey(trimmedRecipientAddress, beneficiaryPubKey)) {
        setFormMessage(RECIPIENT_ADDRESS_MISMATCH_LABEL);
        return;
      }
      setRecipientAddress(derivedRecipient);
      await createCampaign({
        name: trimmedName,
        description: trimmedDescription,
        beneficiaryAddress: derivedRecipient,
        recipientAddress: derivedRecipient,
        beneficiaryPubkey: beneficiaryPubKey,
        beneficiaryPubKey,
        contractVersion: 'teyolia-covenant-v1',
        goal: parsedGoal.sats,
        expiresAt: expiresAtIso,
      });

      setFormMessage('Campaña creada correctamente.');
      resetForm();
      loadCampaigns();
    } catch (err) {
      setFormMessage(err instanceof Error ? err.message : 'Error al crear la campaña.');
    } finally {
      setCreating(false);
    }
  };

  const filtered = campaigns.filter((campaign) => {
    if (filterStatus === 'Todas') return true;
    if (filterStatus === 'Borradores') return campaign.status === 'draft';
    if (filterStatus === 'Activas') return campaign.status === 'active';
    if (filterStatus === 'Expiradas') return campaign.status === 'expired';
    if (filterStatus === 'Meta alcanzada') return campaign.status === 'funded';
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'Recaudación') return monetaryEnabled ? (b.totalPledged ?? 0) - (a.totalPledged ?? 0) : 0;
    if (sortBy === 'Meta') {
      if (/^[0-9]+$/.test(String(a.goal)) && /^[0-9]+$/.test(String(b.goal))) {
        const left = BigInt(a.goal);
        const right = BigInt(b.goal);
        return left < right ? -1 : left > right ? 1 : 0;
      }
      return Number(a.goal) - Number(b.goal);
    }
    if (sortBy === 'Próximas a vencer') {
      return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
    }
    return 0;
  });

  const recipientAddressMismatch = Boolean(
    publicKey
    && recipientAddress.trim()
    && !recipientAddressMatchesPublicKey(recipientAddress, publicKey)
  );

  return (
    <div>
      <h2 style={{ marginBottom: 2 }}>Teyolia</h2>
      <small style={{ display: 'block', marginBottom: 6 }}>Flipstarter 2.0</small>
      <p style={{ marginTop: 0, opacity: 0.9 }}>🐾 guardian xolo</p>
      {globalStats && (
        <div className="global-stats-grid">
          <div className="stat-card">
            <span className="stat-value">{globalStats.totalCampaigns}</span>
            <span className="stat-label">Proyectos</span>
          </div>
          <div className="stat-card">
            <span className="stat-value">{globalStats.totalPledges}</span>
            <span className="stat-label">Donaciones</span>
          </div>
          <div className="stat-card">
            <span className="stat-value"><AmountDisplay sats={globalStats.totalRaisedSats} /></span>
            <span className="stat-label">Recaudado</span>
          </div>
        </div>
      )}
      {monetaryEnabled ? <><SecurityBanner /><WalletConnectBar /></> : <MetadataBanner />}
      <div style={{ marginBottom: 16 }}>
        <Link
          to="/campaigns/create"
          style={{
            display: 'inline-block',
            padding: '12px 16px',
            borderRadius: 8,
            background: '#005bbb',
            color: '#fff',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          {monetaryEnabled ? 'Crear campaña (guiado)' : 'Crear registro de metadata'}
        </Link>
        <Link
          to="/mis-campanas"
          style={{
            display: 'inline-block',
            marginLeft: 8,
            padding: '12px 16px',
            borderRadius: 8,
            background: '#0f7f72',
            color: '#fff',
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          {monetaryEnabled ? 'Mis campañas' : 'Registros'}
        </Link>
        {monetaryEnabled && <p style={{ marginTop: 8, marginBottom: 0 }}>
          <small>
            Solo cobramos 1%
            {' '}
            <button
              type="button"
              title="El 1% solo se cobra si se fondea completamente."
              aria-label="Info sobre fee del 1%"
              style={{
                border: 'none',
                background: 'transparent',
                cursor: 'help',
                fontWeight: 700,
                padding: 0,
                margin: 0,
              }}
            >
              i
            </button>
          </small>
        </p>}
      </div>
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
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          Estado:
          <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
            <option>Todas</option>
            <option>Borradores</option>
            {monetaryEnabled && <option>Activas</option>}
            {monetaryEnabled && <option>Expiradas</option>}
            {monetaryEnabled && <option>Meta alcanzada</option>}
          </select>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          Ordenar por:
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option value="Recaudación">{monetaryEnabled ? 'Recaudación' : 'Orden del registro'}</option>
            <option>Meta</option>
            <option>Próximas a vencer</option>
          </select>
        </label>
      </div>
      {monetaryEnabled && <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
        <button type="button" onClick={() => setShowCreateForm((prev) => !prev)}>
          {showCreateForm ? 'Ocultar creación manual' : 'Mostrar creación manual'}
        </button>
        {showCreateForm && (
          <form onSubmit={handleCreateSubmit} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nombre de campaña"
            />
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Descripción"
              rows={3}
            />
            <input
              type="text"
              value={recipientAddress}
              onChange={(event) => setRecipientAddress(event.target.value)}
              placeholder="recipientAddress (ecash:...)"
            />
            <small>
              {publicKey
                ? `Clave pública de Tonalli: ${publicKey.slice(0, 8)}…${publicKey.slice(-6)}`
                : 'La clave pública del beneficiario sale de la sesión de Tonalli. Si esta sesión no la trae, hay que reconectar la wallet antes de crear la campaña.'}
            </small>
            <input
              type="text"
              inputMode="decimal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Meta (XEC)"
            />
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <button type="submit" disabled={creating || recipientAddressMismatch}>
              {recipientAddressMismatch
                ? RECIPIENT_ADDRESS_MISMATCH_LABEL
                : creating
                  ? 'Creando...'
                  : 'Crear campaña'}
            </button>
            {formMessage && <p>{formMessage}</p>}
          </form>
        )}
      </div>}
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
      {!loading && sorted.length === 0 && !error && <p>No campaigns found.</p>}
      {sorted.map((c) => (
        <CampaignCard key={c.id} campaign={c} />
      ))}
    </div>
  );
};
