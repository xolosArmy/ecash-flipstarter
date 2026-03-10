import React from 'react';
import { getExplorerUrl } from '../utils/explorer';

type ExplorerLinkProps = {
  txid: string;
  label?: string;
};

function truncateTxid(txid: string): string {
  if (txid.length <= 24) return txid;
  return `${txid.slice(0, 10)}...${txid.slice(-10)}`;
}

export const ExplorerLink: React.FC<ExplorerLinkProps> = ({ txid, label }) => {
  const normalized = txid?.trim();
  if (!normalized) return null;

  return (
    <a href={getExplorerUrl(normalized)} target="_blank" rel="noreferrer">
      {label || truncateTxid(normalized)}
    </a>
  );
};
