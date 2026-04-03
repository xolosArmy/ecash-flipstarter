const explorerBaseUrl = (import.meta.env.VITE_EXPLORER_BASE_URL || 'https://explorer.xolosarmy.xyz')
  .replace(/\/+$/, '');

export function getExplorerTxUrl(txid: string): string {
  return `${explorerBaseUrl}/tx/${encodeURIComponent(txid)}`;
}

export function getExplorerAddressUrl(address: string): string {
  return `${explorerBaseUrl}/address/${encodeURIComponent(address)}`;
}
