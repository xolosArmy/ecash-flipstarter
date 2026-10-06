import React, { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createCampaign } from '../api/client';
import { MetadataBanner } from '../components/MetadataBanner';
import { useCampaignCapabilities } from '../context/CampaignCapabilities';
import { isMetadataOnly } from '../utils/campaignMode';

/** Metadata creation never constructs or sends beneficiary/contract/wallet fields. */
export const CreateCampaign: React.FC = () => {
  const navigate = useNavigate();
  const { ready, monetaryEnabled } = useCampaignCapabilities();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submitPending = useRef(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ready || monetaryEnabled || submitPending.current) return;
    setError(null);
    if (name.trim().length < 3) {
      setError('El nombre debe tener al menos 3 caracteres.');
      return;
    }
    if (!/^[0-9]{1,30}$/.test(goal.trim())) {
      setError('La meta propuesta debe contener entre 1 y 30 dígitos (0 permitido).');
      return;
    }
    const expiration = new Date(expiresAt);
    if (!expiresAt || !Number.isFinite(expiration.getTime()) || expiration.getTime() <= Date.now()) {
      setError('Selecciona una fecha futura válida.');
      return;
    }
    submitPending.current = true;
    setSubmitting(true);
    try {
      const campaign = await createCampaign({
        name: name.trim(), goal: goal.trim(), description: description.trim(),
        expiresAt: expiration.toISOString(),
      });
      if (!isMetadataOnly(campaign)) throw new Error('El backend no devolvió un registro de metadata. No se iniciará ninguna acción monetaria.');
      window.dispatchEvent(new Event('campaigns:refresh'));
      navigate(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar el registro.');
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Link to="/">Volver</Link>
      <h2>Crear registro de campaña</h2>
      <MetadataBanner />
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
        <label style={{ display: 'grid', gap: 4 }}>Nombre
          <input name="name" value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Meta propuesta (entero, solo planificación)
          <input name="goal" type="text" inputMode="numeric" value={goal} onChange={(event) => setGoal(event.target.value)} required />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Fecha propuesta de expiración
          <input name="expiresAt" type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} required />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>Descripción
          <textarea name="description" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <button type="submit" disabled={!ready || monetaryEnabled || submitting}>
          {submitting ? 'Guardando...' : 'Guardar metadata'}
        </button>
        {error && <p role="alert" style={{ color: '#b00020', margin: 0 }}>{error}</p>}
      </form>
    </div>
  );
};
