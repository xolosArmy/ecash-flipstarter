import React from 'react';

export const MetadataBanner: React.FC = () => (
  <p role="note" style={{ border: '1px solid #39786b', borderRadius: 8, padding: 12 }}>
    <strong>Modo no monetario: solo metadata.</strong>{' '}
    El registro guarda una propuesta y su planificación. No crea instrumentos ni permite activar campañas,
    recibir fondos o ejecutar pagos. La meta y el PnL son propuestas, no saldos ni rendimientos garantizados.
  </p>
);
