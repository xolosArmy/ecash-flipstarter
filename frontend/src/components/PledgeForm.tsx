import React, { useEffect, useMemo, useState } from 'react';
import { confirmLatestPendingPledgeTx, createPledgeTx, fetchCampaign } from '../api/client';
import type { BuiltTxResponse } from '../api/types';
import { useWalletConnect } from '../wallet/useWalletConnect';
import { useToast } from './ToastProvider';
import { parseXecInputToSats } from '../utils/amount';
import { ExplorerLink } from './ExplorerLink';

interface Props {
  campaignId: string;
  campaignAddress?: string;
  onBuiltTx?: (tx: BuiltTxResponse) => void;
  onBroadcastSuccess?: () => void;
}

const SATS_PER_XEC = 100n;

function normalizeEcashAddress(address: string): string {
  const trimmed = address.trim();
  if (!trimmed) return '';
  if (trimmed.includes(':')) return trimmed;
  return `ecash:${trimmed}`;
}

function xecToSats(amountXec: bigint | string | number): string {
  if (typeof amountXec === 'bigint') {
    return (amountXec * SATS_PER_XEC).toString();
  }

  const raw = String(amountXec).trim();
  if (!raw) {
    throw new Error('Monto inválido en XEC.');
  }

  const normalized = raw.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error('Monto inválido en XEC.');
  }

  const [wholePart, decimals = ''] = normalized.split('.');
  const paddedDecimals = (decimals + '00').slice(0, 2);
  return (BigInt(wholePart) * SATS_PER_XEC + BigInt(paddedDecimals)).toString();
}

function normalizeOutputValueSats(value: string | number | bigint): string {
  return typeof value === 'bigint' ? value.toString() : String(value);
}

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

export const PledgeForm: React.FC<Props> = ({
  campaignId,
  campaignAddress,
  onBuiltTx,
  onBroadcastSuccess,
}) => {
  const [contributorAddressFull, setContributorAddressFull] = useState('');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const [broadcastResult, setBroadcastResult] = useState('');
  const [loading, setLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [uiError, setUiError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [apiCampaignAddress, setApiCampaignAddress] = useState('');

  const {
    connected,
    topic,
    addresses,
    requestSignAndBroadcastIntent,
    disconnect,
    setLastTxid,
  } = useWalletConnect();
  const { showToast } = useToast();

  useEffect(() => {
    if (!connected) return;
    if (contributorAddressFull.trim()) return;
    if (addresses.length > 0) {
      setContributorAddressFull(normalizeEcashAddress(addresses[0]));
    }
  }, [connected, addresses, contributorAddressFull]);

  useEffect(() => {
    if (campaignAddress?.trim()) {
      setApiCampaignAddress(normalizeEcashAddress(campaignAddress));
      return;
    }
    fetchCampaign(campaignId)
      .then((campaign) => {
        const fromApi = campaign.covenant?.campaignAddress || campaign.campaignAddress || '';
        setApiCampaignAddress(fromApi ? normalizeEcashAddress(fromApi) : '');
      })
      .catch(() => {
        setApiCampaignAddress('');
      });
  }, [campaignAddress, campaignId]);

  const hasWalletConnectSession = connected && Boolean(topic);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (loading) return;

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

    const trimmedMessage = message.trim();
    if (trimmedMessage.length > 200) {
      setUiError('El mensaje debe tener máximo 200 caracteres.');
      return;
    }

    if (!normalizedAddress) {
      setUiError('Conecta Tonalli por WalletConnect para obtener contributorAddress antes de donar.');
      setStatusMessage('');
      return;
    }

    if (!hasWalletConnectSession) {
      setUiError('Conecta Tonalli por WalletConnect para donar');
      setStatusMessage('');
      return;
    }

    setAmountError('');
    setLoading(true);
    setStatusMessage('Creando pledge...');
    setUiError('');
    setBroadcastResult('');

    try {
      const amountXec = Number(parsedAmount.sats) / 100;
      const built = await createPledgeTx(
        campaignId,
        normalizedAddress,
        amountXec,
        trimmedMessage || undefined,
      );
      onBuiltTx?.(built);

      const wcOfferId = built.wcOfferId ?? built.offerId;
      if (!wcOfferId) {
        throw new Error('El backend no devolvió wcOfferId/offerId para WalletConnect.');
      }

      const fallbackCampaignAddress = apiCampaignAddress || campaignAddress || '';
      const outputs = built.outputs?.length
        ? built.outputs.map((output) => ({
            address: output.address,
            valueSats: normalizeOutputValueSats(output.valueSats),
          }))
        : (() => {
            const normalizedCampaign = normalizeEcashAddress(fallbackCampaignAddress);
            if (!normalizedCampaign) {
              throw new Error('No se pudo resolver campaignAddress para construir outputs de intent.');
            }
            return [
              {
                address: normalizedCampaign,
                valueSats: xecToSats(amount),
              },
            ];
          })();

      const totalSats = outputs.reduce((sum, output) => sum + BigInt(output.valueSats), 0n).toString();
      console.info('[PLEDGE][WC] requesting signAndBroadcastTransaction', {
        offerId: wcOfferId,
        outputsCount: outputs.length,
        totalSats,
      });

      setStatusMessage('Esperando confirmación en Tonalli...');
      const { txid } = await requestSignAndBroadcastIntent({
        offerId: wcOfferId,
        outputs,
        message: trimmedMessage || undefined,
        userPrompt: 'Donate to campaign',
      });
      console.info('[PLEDGE][WC] txid', txid);

      await confirmLatestPendingPledgeTx(campaignId, txid, wcOfferId);
      setBroadcastResult(`Transacción enviada: ${txid}`);
      setStatusMessage(`Transacción enviada: ${txid}`);
      localStorage.setItem(`tonalli:txid:${campaignId}`, txid);
      setLastTxid(txid);
      onBroadcastSuccess?.();
      showToast('Pledge enviado on-chain', 'success');
    } catch (err) {
      console.error('[PLEDGE] error', err);
      const message = err instanceof Error ? err.message : '';
      if (message.toLowerCase().includes('walletconnect')) {
        setUiError('WalletConnect request failed. Desconecta y vuelve a conectar.');
      } else {
        setUiError(formatPledgeError(err));
      }
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  };

  const copyContributorAddress = async () => {
    if (!contributorAddressFull) return;
    try {
      await navigator.clipboard.writeText(contributorAddressFull);
      setStatusMessage('Dirección completa copiada.');
      setUiError('');
    } catch {
      setUiError('No se pudo copiar la dirección.');
    }
  };

  const broadcastTxid = useMemo(() => {
    const match = broadcastResult.match(/[0-9a-f]{64}/i);
    return match ? match[0] : null;
  }, [broadcastResult]);

  return (
    <div style={{ border: '1px solid #eee', padding: 12, borderRadius: 8 }}>
      <h4>Pledge</h4>
      {apiCampaignAddress && (
        <p style={{ marginTop: 0 }}>
          Campaign address: <code>{apiCampaignAddress}</code>
        </p>
      )}
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
        <button type="submit" disabled={loading || !hasWalletConnectSession}>
          {loading ? 'Procesando...' : 'Donar'}
        </button>
        {!hasWalletConnectSession && (
          <p style={{ color: '#b00020' }}>Conecta Tonalli por WalletConnect para donar</p>
        )}
        {statusMessage && <p>{statusMessage}</p>}
        {uiError && <p style={{ color: '#b00020' }}>{uiError}</p>}
        {uiError.includes('WalletConnect request failed') && (
          <button type="button" onClick={() => void disconnect()}>
            Desconectar y reconectar
          </button>
        )}
      </form>
      {broadcastResult && <p>{broadcastResult}</p>}
      {broadcastTxid && (
        <p>
          Ver en explorer: <ExplorerLink txid={broadcastTxid} />
        </p>
      )}
    </div>
  );
};
