import React, { useState } from 'react';
import { broadcastTx, createPledgeTx } from '../api/client';
import type { BuiltTxResponse } from '../api/types';
import { buildTonalliExternalSignUrl } from '../wallet/tonalliDeeplink';

interface Props {
  campaignId: string;
  onBuiltTx?: (tx: BuiltTxResponse) => void;
  onBroadcastSuccess?: () => void;
}

export const PledgeForm: React.FC<Props> = ({
  campaignId,
  onBuiltTx,
  onBroadcastSuccess,
}) => {
  const [contributorAddress, setContributorAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [unsignedHex, setUnsignedHex] = useState('');
  const [signedHex, setSignedHex] = useState('');
  const [broadcastResult, setBroadcastResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [tonalliMessage, setTonalliMessage] = useState('');
  const [tonalliUrl, setTonalliUrl] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setBroadcastResult('');
    try {
      const built = await createPledgeTx(campaignId, contributorAddress, BigInt(amount));
      const hex = built.unsignedTxHex || built.rawHex || '';
      setUnsignedHex(hex);
      setSignedHex('');
      onBuiltTx?.(built);
    } catch (err: any) {
      if (err?.response?.status === 400) {
        const msg = err.response.data?.error;
        if (msg === 'invalid-amount') {
          alert('El monto debe ser un número entero mayor o igual a 1000 satoshis.');
        } else {
          alert(`Error: ${msg || 'Algo salió mal'}`);
        }
      } else {
        alert('Error inesperado al contribuir');
      }
    } finally {
      setLoading(false);
    }
  };

  const copyUnsigned = async () => {
    try {
      await navigator.clipboard.writeText(unsignedHex);
      setBroadcastResult('Unsigned tx copied.');
    } catch (err) {
      alert('No se pudo copiar el hex.');
    }
  };

  const handleBroadcast = async () => {
    if (!signedHex.trim()) {
      alert('Signed tx hex requerido.');
      return;
    }
    setBroadcasting(true);
    setBroadcastResult('');
    try {
      const result = await broadcastTx(signedHex);
      setBroadcastResult(`Broadcasted. TXID: ${result.txid}`);
      onBroadcastSuccess?.();
    } catch (err) {
      setBroadcastResult(`Error: ${(err as Error).message}`);
    } finally {
      setBroadcasting(false);
    }
  };

  const handleTonalli = () => {
    if (!unsignedHex) {
      setTonalliMessage('Build the pledge transaction first.');
      return;
    }

    const url = buildTonalliExternalSignUrl({
      unsignedTxHex: unsignedHex,
    });
    setTonalliUrl(url);
    setTonalliMessage('');

    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    if (!popup) {
      setTonalliMessage('Pop-up blocked. Use the link below to open Tonalli.');
    } else {
      setTonalliMessage('Tonalli opened in a new tab. Complete the signing flow there.');
    }
  };

  return (
    <div style={{ border: '1px solid #eee', padding: 12, borderRadius: 8 }}>
      <h4>Pledge</h4>
      <form onSubmit={submit}>
        <div>
          <label>Contributor Address</label>
          <input
            type="text"
            value={contributorAddress}
            onChange={(e) => setContributorAddress(e.target.value)}
            required
          />
        </div>
        <div>
          <label>Amount (satoshis)</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? 'Building...' : 'Build Pledge Tx'}
        </button>
      </form>
      {unsignedHex && (
        <div style={{ marginTop: 12 }}>
          <p>Unsigned tx hex:</p>
          <textarea
            readOnly
            value={unsignedHex}
            rows={6}
            style={{ width: '100%', wordBreak: 'break-all' }}
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={copyUnsigned}>
              Copy unsigned tx
            </button>
          </div>
          <p style={{ marginTop: 8 }}>
            Firma este hex en Tonalli o herramienta externa, luego pega el hex firmado abajo para
            hacer broadcast.
          </p>
          <div style={{ marginTop: 12, padding: 12, border: '1px dashed #ddd', borderRadius: 8 }}>
            <strong>Sign with Tonalli</strong>
            <p style={{ marginTop: 6 }}>
              Open Tonalli to sign and broadcast, then return here with your txid.
            </p>
            <button type="button" onClick={handleTonalli}>
              Open Tonalli to Sign & Broadcast
            </button>
            {tonalliUrl && (
              <p style={{ marginTop: 8 }}>
                <a href={tonalliUrl} target="_blank" rel="noreferrer">
                  Open Tonalli in a new tab
                </a>
              </p>
            )}
            {tonalliMessage && <p>{tonalliMessage}</p>}
          </div>
          <label>Signed Tx Hex</label>
          <textarea
            value={signedHex}
            onChange={(e) => setSignedHex(e.target.value)}
            rows={6}
            style={{ width: '100%', wordBreak: 'break-all' }}
          />
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={handleBroadcast} disabled={broadcasting}>
              {broadcasting ? 'Broadcasting...' : 'Broadcast signed tx'}
            </button>
          </div>
          {broadcastResult && <p>{broadcastResult}</p>}
          <p>
            <em>Si Tonalli no abre, usa el flujo de pegar hex firmado y hacer broadcast.</em>
          </p>
        </div>
      )}
    </div>
  );
};
