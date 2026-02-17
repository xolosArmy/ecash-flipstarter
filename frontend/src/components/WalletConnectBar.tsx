import React, { useMemo, useState } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useWalletConnect } from '../wallet/useWalletConnect';

function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

function shortenAddress(address: string) {
  if (address.length <= 18) return address;
  return `${address.slice(0, 10)}...${address.slice(-6)}`;
}

export const WalletConnectBar: React.FC = () => {
  const {
    connected,
    addresses,
    uri,
    status,
    error,
    projectIdMissing,
    connect,
    disconnect,
    resetSession,
    requestAddresses,
  } = useWalletConnect();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const isMobile = useMemo(() => isMobileDevice(), []);
  const primaryAddress = addresses[0];
  const showQr = Boolean(uri) && !connected;
  const isConnecting = status === 'connecting' || status === 'awaiting';
  const uriValue = uri ?? '';

  const handleCopy = async () => {
    if (!uriValue) return;
    try {
      await navigator.clipboard.writeText(uriValue);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    } finally {
      window.setTimeout(() => setCopyState('idle'), 1500);
    }
  };

  return (
    <section style={{ border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>Tonalli WalletConnect</strong>
        {connected && (
          <button type="button" onClick={disconnect}>
            Desconectar
          </button>
        )}
      </div>
      {projectIdMissing && (
        <p style={{ color: '#b00020', marginTop: 8 }}>
          Falta Project ID de WalletConnect. Configura VITE_WC_PROJECT_ID.
        </p>
      )}
      {error && (
        <div style={{ marginTop: 8 }}>
          <p style={{ color: '#b00020', marginTop: 0, marginBottom: 6 }}>{error}</p>
          <button type="button" onClick={resetSession}>
            Reset sesión WC
          </button>
        </div>
      )}
      {!connected ? (
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={connect}
            disabled={projectIdMissing || isConnecting}
          >
            {isConnecting ? 'Conectando...' : 'Conectar Tonalli (WalletConnect)'}
          </button>
          {status === 'awaiting' && <p style={{ marginTop: 8 }}>Escanea con Tonalli</p>}
          {showQr && (
            <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
              <QRCodeCanvas value={uriValue} size={200} includeMargin />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <small style={{ wordBreak: 'break-all' }}>{uriValue}</small>
                <button type="button" onClick={handleCopy}>
                  {copyState === 'copied'
                    ? 'Copiado'
                    : copyState === 'failed'
                      ? 'Error'
                      : 'Copiar'}
                </button>
              </div>
              {isMobile && (
                <small>
                  <a href={uriValue} rel="noreferrer">
                    Abrir Tonalli
                  </a>
                </small>
              )}
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          {primaryAddress ? (
            <p>Conectado: {shortenAddress(primaryAddress)}</p>
          ) : (
            <button type="button" onClick={requestAddresses}>
              Obtener dirección
            </button>
          )}
        </div>
      )}
    </section>
  );
};
