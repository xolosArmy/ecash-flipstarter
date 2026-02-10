import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createCampaign } from '../api/client';

// Smoke steps:
// 1) Start backend and frontend.
// 2) Create a campaign with a valid beneficiaryAddress.
// 3) Confirm it appears in the list and `/campaigns/:id` renders.
export const CreateCampaign: React.FC = () => {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [beneficiaryAddress, setBeneficiaryAddress] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const goalValue = Number(goal);
    const expiresAtValue = expiresAt.trim();
    const beneficiaryAddressValue = beneficiaryAddress.trim();
    const descriptionValue = description.trim();
    const locationValue = location.trim();

    if (trimmedName.length < 3) {
      setError('El nombre debe tener al menos 3 caracteres.');
      return;
    }
    if (!Number.isInteger(goalValue) || goalValue <= 0) {
      setError('La meta debe ser un entero positivo.');
      return;
    }
    if (!expiresAtValue) {
      setError('La fecha de expiración es obligatoria.');
      return;
    }
    if (!beneficiaryAddressValue) {
      setError('La dirección beneficiaria es obligatoria.');
      return;
    }

    setSubmitting(true);
    try {
      const campaign = await createCampaign({
        name: trimmedName,
        goal: goalValue,
        expiresAt: new Date(expiresAtValue).toISOString(),
        beneficiaryAddress: beneficiaryAddressValue,
        description: descriptionValue || undefined,
        location: locationValue || undefined,
      });
      window.dispatchEvent(new Event('campaigns:refresh'));
      navigate(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear la campaña.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Link to="/">Volver</Link>
      <h2>Crear campaña</h2>
      <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
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
          Expira el
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Beneficiary Address (ecash:)
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
        <button type="submit" disabled={submitting}>
          {submitting ? 'Creando...' : 'Crear campaña'}
        </button>
        {error && <p style={{ color: '#b00020', margin: 0 }}>{error}</p>}
      </form>
    </div>
  );
};
