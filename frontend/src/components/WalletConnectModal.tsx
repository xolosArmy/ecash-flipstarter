import React, { useMemo } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { useWalletConnect } from '../wallet/useWalletConnect';

function isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

export const WalletConnectModal: React.FC = () => {
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

  const primaryAddress = addresses[0];
  const showQr = Boolean(uri) && !connected;
  const isMobile = useMemo(() => isMobileDevice(), []);
  const uriValue = uri || '';

  return (
    <div style={{ border: '1px solid #eee', padding: 12, borderRadius: 8, marginBottom: 12 }}>
      <h4>Tonalli WalletConnect</h4>
      {projectIdMissing && (
        <p style={{ color: '#b00020' }}>
          Falta Project ID de WalletConnect. Configura VITE_WC_PROJECT_ID.
        </p>
      )}
      {error && (
        <div>
          <p style={{ color: '#b00020', marginBottom: 8 }}>{error}</p>
          <button type="button" onClick={resetSession}>
            Reset sesión WC
          </button>
        </div>
      )}
      {!connected ? (
        <div>
          <button
            type="button"
            onClick={connect}
            disabled={projectIdMissing || status === 'connecting' || status === 'awaiting'}
          >
            {status === 'connecting' || status === 'awaiting' ? 'Conectando...' : 'Conectar Tonalli'}
          </button>
          {status === 'awaiting' && <p>Esperando aprobación...</p>}
          {showQr && (
            <div style={{ marginTop: 12 }}>
              <QRCodeCanvas value={uriValue} size={180} includeMargin />
              <p style={{ marginTop: 8, wordBreak: 'break-all' }}>{uriValue}</p>
              {isMobile && (
                <p style={{ marginTop: 8 }}>
                  <a href={uriValue} rel="noreferrer">
                    Abrir Tonalli
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <p>Conectado.</p>
          {primaryAddress ? (
            <p>
              Dirección: {primaryAddress.slice(0, 10)}...{primaryAddress.slice(-6)}
            </p>
          ) : (
            <button type="button" onClick={requestAddresses}>
              Obtener dirección
            </button>
          )}
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={disconnect}>
              Desconectar
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
