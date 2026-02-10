import React from 'react';

export const SecurityBanner: React.FC = () => {
  return (
    <div
      role="note"
      style={{
        border: '1px solid rgba(217, 179, 106, 0.5)',
        background: 'rgba(217, 179, 106, 0.1)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 12,
      }}
    >
      🛡️ Teyolia es non-custodial. Nunca te pediremos tu seed o llave privada. Solo firma vía WalletConnect.
    </div>
  );
};
