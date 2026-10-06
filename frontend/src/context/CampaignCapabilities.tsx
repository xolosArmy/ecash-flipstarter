import React, { createContext, useContext, useEffect, useState } from 'react';
import { fetchCapabilities } from '../api/client';
import type { CampaignMode } from '../types/metadata';
import { isMonetaryUiEnabled } from '../utils/campaignMode';

const CapabilitiesContext = createContext<{
  capabilities: CampaignMode | null;
  monetaryEnabled: boolean;
  ready: boolean;
  error: string | null;
}>({ capabilities: null, monetaryEnabled: false, ready: false, error: null });

export const CampaignCapabilitiesProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [capabilities, setCapabilities] = useState<CampaignMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    fetchCapabilities().then((result) => {
      const metadata = result.apiVersion === 'teyolia.metadata.v1'
        && result.recordKind === 'metadata-only'
        && result.monetaryEnabled === false
        && result.capabilities?.monetary === false;
      if (!metadata && !isMonetaryUiEnabled(result)) throw new Error('Modo del backend desconocido.');
      if (active) setCapabilities(result);
    }).catch(() => {
      if (active) setError('No se pudo verificar el modo del backend. Las acciones permanecen deshabilitadas.');
    });
    return () => { active = false; };
  }, []);
  return (
    <CapabilitiesContext.Provider value={{
      capabilities,
      monetaryEnabled: isMonetaryUiEnabled(capabilities),
      ready: capabilities !== null,
      error,
    }}>
      {children}
    </CapabilitiesContext.Provider>
  );
};

export function useCampaignCapabilities() {
  return useContext(CapabilitiesContext);
}
