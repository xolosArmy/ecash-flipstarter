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

export const Home: React.FC = () => {
  const [campaigns, setCampaigns] = useState<CampaignSummaryResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [filterStatus, setFilterStatus] = useState('Todas');
  const [sortBy, setSortBy] = useState('Recaudación');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [beneficiaryAddress, setBeneficiaryAddress] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const navigate = useNavigate();

  const loadCampaigns = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then(async (data) => {
        const campaignsList = data || [];
        const validCampaigns = campaignsList.filter((campaign) => {
          const rawId = campaign?.id?.toString().trim();
          const rawSlug = campaign?.slug?.toString().trim();
          const hasValidId = Boolean(rawId && rawId !== 'undefined' && rawId !== 'null');
          const hasValidSlug = Boolean(rawSlug && rawSlug !== 'undefined' && rawSlug !== 'null');
          return hasValidId || hasValidSlug;
        });

        const discardedCount = campaignsList.length - validCampaigns.length;
        if (discardedCount > 0) {
          console.warn(`Discarded ${discardedCount} invalid campaign records without usable id/slug`);
        }

        const summaries = await Promise.all(
          validCampaigns.map(async (campaign) => {
            const campaignKey = String(campaign.id || campaign.slug || '').trim();
            const summary = await fetchCampaignSummary(campaign.id || campaign.slug || campaignKey);
            return {
              ...summary,
              id: summary.id || campaignKey,
              slug: summary.slug || campaign.slug || campaignKey,
            };
          }),
        );

        return summaries.filter((summary): summary is CampaignSummaryResponse => {
          const rawId = summary?.id?.toString().trim();
          return Boolean(rawId && rawId !== 'undefined' && rawId !== 'null');
        });
      })
      .then((summaries) => setCampaigns(summaries))
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load campaigns');
        setCampaigns([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    fetchGlobalStats().then(setGlobalStats).catch(console.error);
  }, []);

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
    setBeneficiaryAddress('');
    setGoal('');
    setExpiresAt('');
  };

  const handleCreateSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormMessage(null);

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedBeneficiaryAddress = beneficiaryAddress.trim();
    const parsedGoal = parseXecInputToSats(goal);
    const trimmedExpiresAt = expiresAt.trim();

    if (!trimmedName || !trimmedDescription || !trimmedBeneficiaryAddress || !trimmedExpiresAt) {
      setFormMessage('Completa todos los campos.');
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

    try {
      await createCampaign({
        name: trimmedName,
        description: trimmedDescription,
        beneficiaryAddress: trimmedBeneficiaryAddress,
        goal: parsedGoal.sats,
        expiresAt: expiresAtIso,
      });

      setFormMessage('Campaña creada correctamente.');
      resetForm();
      loadCampaigns();
    } catch (err) {
      setFormMessage(err instanceof Error ? err.message : 'Error al crear la campaña.');
    }
  };

  const filtered = campaigns.filter((campaign) => {
    if (filterStatus === 'Todas') return true;
    if (filterStatus === 'Activas') return campaign.status === 'active';
    if (filterStatus === 'Expiradas') return campaign.status === 'expired';
    if (filterStatus === 'Meta alcanzada') return campaign.status === 'funded';
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'Recaudación') return b.totalPledged - a.totalPledged;
    if (sortBy === 'Meta') return a.goal - b.goal;
    if (sortBy === 'Próximas a vencer') {
      return new Date(a.expiresAt).getTime() - new Date(b.expiresAt).getTime();
    }
    return 0;
  });

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
      <SecurityBanner />
      <WalletConnectBar />
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
          Crear campaña (guiado)
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
          Mis campañas
        </Link>
        <p style={{ marginTop: 8, marginBottom: 0 }}>
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
        </p>
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
            <option>Activas</option>
            <option>Expiradas</option>
            <option>Meta alcanzada</option>
          </select>
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          Ordenar por:
          <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
            <option>Recaudación</option>
            <option>Meta</option>
            <option>Próximas a vencer</option>
          </select>
        </label>
      </div>
      <div style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
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
              value={beneficiaryAddress}
              onChange={(event) => setBeneficiaryAddress(event.target.value)}
              placeholder="Beneficiary Address (ecash:...)"
            />
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
            <button type="submit">Crear campaña</button>
            {formMessage && <p>{formMessage}</p>}
          </form>
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
      {!loading && sorted.length === 0 && !error && <p>No campaigns found.</p>}
      {sorted.map((c) => (
        <CampaignCard key={c.id} campaign={c} />
      ))}
    </div>
  );
};
