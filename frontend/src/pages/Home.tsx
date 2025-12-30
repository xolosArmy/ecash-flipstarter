import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCampaigns, fetchCampaignSummary } from '../api/client';
import type { CampaignSummary as CampaignSummaryResponse } from '../types/campaign';
import { CampaignCard } from '../components/CampaignCard';

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
  const [recipientAddress, setRecipientAddress] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadCampaigns = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCampaigns()
      .then((data) => Promise.all(data.map((campaign) => fetchCampaignSummary(campaign.id))))
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
    setFormMessage(null);

    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedRecipientAddress = recipientAddress.trim();
    const numericGoal = Number(goal);
    const trimmedExpiresAt = expiresAt.trim();

    if (!trimmedName || !trimmedDescription || !trimmedRecipientAddress || !trimmedExpiresAt) {
      setFormMessage('Completa todos los campos.');
      return;
    }
    if (!Number.isFinite(numericGoal) || numericGoal <= 0) {
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
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          description: trimmedDescription,
          recipientAddress: trimmedRecipientAddress,
          goal: numericGoal,
          expiresAt: expiresAtIso,
        }),
      });

      if (!res.ok) {
        const errorPayload = await res.json().catch(() => ({}));
        const message = errorPayload.error || `Error ${res.status}`;
        setFormMessage(message);
        return;
      }

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
              value={recipientAddress}
              onChange={(event) => setRecipientAddress(event.target.value)}
              placeholder="Dirección eCash"
            />
            <input
              type="number"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Meta (sats)"
              min={1}
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
