import React, { useEffect, useState } from 'react';
import { broadcastTx, createPledgeTx } from '../api/client';
import type { BuiltTxResponse } from '../api/types';
import { buildTonalliExternalSignUrl } from '../wallet/tonalliDeeplink';
import { useWalletConnect } from '../wallet/useWalletConnect';
import { useToast } from './ToastProvider';
import { parseXecInputToSats } from '../utils/amount';
import { ExplorerLink } from './ExplorerLink';

interface Props {
  campaignId: string;
  onBuiltTx?: (tx: BuiltTxResponse) => void;
  onBroadcastSuccess?: () => void;
}

function normalizeEcashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':')) return trimmed;
  return `ecash:${trimmed}`;
}

export const PledgeForm: React.FC<Props> = ({
  campaignId,
  onBuiltTx,
  onBroadcastSuccess,
}) => {
  const [contributorAddressFull, setContributorAddressFull] = useState('');
  const [contributorAddressDisplay, setContributorAddressDisplay] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [unsignedHex, setUnsignedHex] = useState('');
  const [signedHex, setSignedHex] = useState('');
  const [broadcastResult, setBroadcastResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [broadcasting, setBroadcasting] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [uiError, setUiError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [tonalliMessage, setTonalliMessage] = useState('');
  const [tonalliUrl, setTonalliUrl] = useState('');
  const [wcSigning, setWcSigning] = useState(false);

  const {
    signClient,
    connected,
    topic,
    addresses,
    connect,
    requestSignAndBroadcast,
    setLastTxid,
  } = useWalletConnect();
  const { showToast } = useToast();

  const toAddressPreview = (address: string): string => {
    if (!address) return '';
    if (address.length <= 18) return address;
    return `${address.slice(0, 10)}...${address.slice(-6)}`;
  };

  useEffect(() => {
    if (!connected) return;
    if (contributorAddressFull.trim()) return;
    if (addresses.length > 0) {
      setContributorAddressFull(normalizeEcashAddress(addresses[0]));
    }
  }, [connected, addresses, contributorAddressFull]);

  useEffect(() => {
    setContributorAddressDisplay(toAddressPreview(contributorAddressFull));
  }, [contributorAddressFull]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading || wcSigning) return;

    const normalizedAddress = normalizeEcashAddress(contributorAddressFull);
    if (normalizedAddress && normalizedAddress.includes('...')) {
      setUiError('Dirección truncada: copia la completa / reconecta WalletConnect.');
      return;
    }
    if (normalizedAddress) {
      const payload = normalizedAddress.includes(':')
        ? normalizedAddress.split(':').pop() || ''
        : normalizedAddress;
      if (payload.length < 40) {
        setUiError('Contributor address inválida o demasiado corta.');
        return;
      }
    }
    const parsedAmount = parseXecInputToSats(amount);
    if (parsedAmount.error) {
      setAmountError(parsedAmount.error);
      setUiError(parsedAmount.error);
      return;
    }
    if (parsedAmount.sats === null || parsedAmount.sats <= 0) {
      setAmountError('Monto inválido en XEC.');
      setUiError('Monto inválido en XEC.');
      return;
    }
    setAmountError('');
    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 200) {
      setUiError('El mensaje debe tener máximo 200 caracteres.');
      return;
    }

    if (!connected && !normalizedAddress) {
      setStatusMessage('Conectando WalletConnect...');
    }

    const preview = normalizedAddress
      ? `${normalizedAddress.slice(0, 10)}...${normalizedAddress.slice(-6)}`
      : 'walletconnect-session';
    console.log('[PLEDGE] contributorAddressFull', {
      length: normalizedAddress.length,
      preview,
    });

    setLoading(true);
    setStatusMessage('Creando pledge...');
    setUiError('');
    setBroadcastResult('');
    setTonalliMessage('');
    try {
      let activeAddress = normalizedAddress;
      let activeSession = null;
      if (connected && signClient && topic) {
        try {
          activeSession = signClient.session.get(topic);
        } catch {
          activeSession = null;
        }
      }
      if (!connected) {
        const session = await connect();
        console.log('[WC] session namespaces', session?.namespaces);
        const sessionAccounts = session?.namespaces?.ecash?.accounts ?? [];
        const firstAccount = sessionAccounts[0]?.split(':').slice(2).join(':');
        if (!firstAccount) {
          throw new Error('WalletConnect no devolvió cuentas aprobadas.');
        }
        activeSession = session;
        activeAddress = normalizeEcashAddress(firstAccount);
        setContributorAddressFull(activeAddress);
      }
      if (!activeAddress) {
        throw new Error('Contributor address inválida o demasiado corta.');
      }
      const activePayload = activeAddress.includes(':')
        ? activeAddress.split(':').pop() || ''
        : activeAddress;
      if (activePayload.length < 40) {
        setUiError('Contributor address inválida o demasiado corta.');
        return;
      }

      console.log('[PLEDGE] POST /api/campaigns/:id/pledge', {
        campaignId,
        amountXec: amount,
        amountSats: String(parsedAmount.sats),
        contributorAddress: activeAddress,
        messageLength: trimmedMessage.length,
      });
      const resp = await createPledgeTx(
        campaignId,
        activeAddress,
        BigInt(parsedAmount.sats),
        trimmedMessage || undefined,
      );
      const built = resp;
      const hex = built.unsignedTxHex || built.rawHex || '';
      console.log('[PLEDGE] backend response', {
        pledgeId: built.pledgeId ?? null,
        wcOfferId: built.wcOfferId ?? null,
        unsignedTxHexLength: hex.length,
      });
      if (built?.pledgeId) {
        localStorage.setItem(`tonalli:pledgeId:${campaignId}`, built.pledgeId);
      }
      setUnsignedHex(hex);
      setSignedHex('');
      onBuiltTx?.(built);

      const wcOfferId = resp.wcOfferId ?? resp.offerId;
      if (!wcOfferId) {
        throw new Error('El backend no devolvió wcOfferId/offerId para WalletConnect.');
      }
      setTonalliMessage('Esperando confirmación en Tonalli...');
      setStatusMessage('Esperando confirmación en Tonalli...');
      setWcSigning(true);
      try {
        const ecashNs = activeSession?.namespaces?.ecash;
        if (!ecashNs) throw new Error('wc-no-ecash-namespace');

        const chainId =
          (ecashNs.chains && ecashNs.chains[0]) ||
          (() => {
            // fallback from accounts: "ecash:1:ecash:qr..." or "ecash:mainnet:ecash:qr..."
            const parts = ecashNs.accounts?.[0]?.split(':') ?? [];
            if (parts.length < 2) throw new Error('wc-no-chainid');
            return `${parts[0]}:${parts[1]}`;
          })();

        console.log('[PLEDGE] WC chainId from session =', chainId);
        const result = await requestSignAndBroadcast(wcOfferId, chainId);
        const txid = extractTxid(result);
        if (!txid) {
          throw new Error('Tonalli returned an invalid txid.');
        }
        setBroadcastResult(`Transacción enviada: ${txid}`);
        setStatusMessage(`Transacción enviada: ${txid}`);
        localStorage.setItem(`tonalli:txid:${campaignId}`, txid);
        setLastTxid(txid);
        onBroadcastSuccess?.();
        setTonalliMessage('');
        showToast('Pledge enviado on-chain', 'success');
        return;
      } catch (err) {
        console.error('[PLEDGE] WalletConnect request failed', err);
        setUiError(formatPledgeError(err));
        setStatusMessage('No se pudo firmar por WalletConnect, usando modo compatibilidad...');
        handleTonalli('Usando modo compatibilidad (external-sign).', hex);
      } finally {
        setWcSigning(false);
      }
    } catch (err) {
      console.error('[PLEDGE] error', err);
      setUiError(formatPledgeError(err));
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  };

  const copyUnsigned = async () => {
    try {
      await navigator.clipboard.writeText(unsignedHex);
      setBroadcastResult('Unsigned tx copied.');
    } catch (err) {
      setUiError('No se pudo copiar el hex.');
    }
  };

  const copyContributorAddress = async () => {
    if (!contributorAddressFull) return;
    try {
      await navigator.clipboard.writeText(contributorAddressFull);
      setStatusMessage('Dirección completa copiada.');
      setUiError('');
    } catch (err) {
      setUiError('No se pudo copiar la dirección.');
    }
  };

  const handleBroadcast = async () => {
    if (!signedHex.trim()) {
      setUiError('Signed tx hex requerido.');
      return;
    }
    setBroadcasting(true);
    setUiError('');
    setBroadcastResult('');
    try {
      const result = await broadcastTx(signedHex);
      setBroadcastResult(`Transacción enviada: ${result.txid}`);
      setStatusMessage(`Transacción enviada: ${result.txid}`);
      onBroadcastSuccess?.();
      showToast('Pledge enviado on-chain', 'success');
    } catch (err) {
      setUiError(formatPledgeError(err));
    } finally {
      setBroadcasting(false);
    }
  };

  const handleTonalli = (contextMessage?: string, overrideUnsignedHex?: string) => {
    const hex = overrideUnsignedHex || unsignedHex;
    if (!hex) {
      setTonalliMessage('Build the pledge transaction first.');
      return;
    }

    const url = buildTonalliExternalSignUrl({
      unsignedTxHex: hex,
    });
    setTonalliUrl(url);

    const popup = window.open(url, '_blank', 'noopener,noreferrer');
    const prefix = contextMessage ? `${contextMessage} ` : '';
    if (!popup) {
      setTonalliMessage(`${prefix}Pop-up blocked. Use the link below to open Tonalli.`);
    } else {
      setTonalliMessage(`${prefix}Tonalli opened in a new tab. Complete the signing flow there.`);
    }
  };

  function formatPledgeError(err: unknown): string {
    if (err && typeof err === 'object' && 'response' in err) {
      const response = (
        err as { response?: { status?: number; data?: { error?: unknown } } }
      ).response;
      const apiError = response?.data?.error;
      if (typeof apiError === 'string' && apiError.trim()) return apiError;
      if (typeof response?.status === 'number') return `Request failed (${response.status}).`;
    }
    if (err instanceof Error && err.message) return err.message;
    return 'Error inesperado al contribuir.';
  }

  function extractTxid(result: unknown): string | null {
    if (!result) return null;
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && 'txid' in result) {
      const txid = (result as { txid?: unknown }).txid;
      return typeof txid === 'string' ? txid : null;
    }
    return null;
  }

  const broadcastTxid = extractTxidFromText(broadcastResult);

  return (
    <div style={{ border: '1px solid #eee', padding: 12, borderRadius: 8 }}>
      <h4>Pledge</h4>
      <form onSubmit={submit}>
        <div>
          <label>Contributor Address</label>
          <input
            type="text"
            value={contributorAddressFull}
            onChange={(e) => setContributorAddressFull(e.target.value)}
            style={{ width: '100%' }}
            required
          />
          {contributorAddressDisplay && (
            <p style={{ marginTop: 6, marginBottom: 6 }}>
              Vista corta: <code>{contributorAddressDisplay}</code>
            </p>
          )}
          <button type="button" onClick={copyContributorAddress} disabled={!contributorAddressFull}>
            Copiar dirección
          </button>
        </div>
        <div>
          <label>Mensaje (opcional, max 200)</label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={200}
            rows={3}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label>Monto (XEC)</label>
          <input
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              const next = e.target.value;
              setAmount(next);
              const parsed = parseXecInputToSats(next);
              setAmountError(parsed.error || '');
            }}
            required
          />
          {amountError && <p style={{ color: '#b00020', margin: '6px 0 0' }}>{amountError}</p>}
        </div>
        <button type="submit" disabled={loading || wcSigning}>
          {loading ? 'Procesando...' : wcSigning ? 'Esperando confirmación...' : 'Donar'}
        </button>
        {statusMessage && <p>{statusMessage}</p>}
        {uiError && <p style={{ color: '#b00020' }}>{uiError}</p>}
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
          {broadcastTxid && (
            <p>
              Ver en explorer: <ExplorerLink txid={broadcastTxid} />
            </p>
          )}
          <p>
            <em>Si Tonalli no abre, usa el flujo de pegar hex firmado y hacer broadcast.</em>
          </p>
        </div>
      )}
    </div>
  );
};

function extractTxidFromText(message: string): string | null {
  const match = message.match(/[0-9a-f]{64}/i);
  return match ? match[0] : null;
}
