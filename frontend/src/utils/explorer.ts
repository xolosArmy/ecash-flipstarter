const explorerBaseUrl = (import.meta.env.VITE_EXPLORER_BASE_URL || 'https://explorer.e.cash')
  .replace(/\/+$/, '');

export function getExplorerTxUrl(txid: string): string {
  return `${explorerBaseUrl}/tx/${encodeURIComponent(txid)}`;
}
