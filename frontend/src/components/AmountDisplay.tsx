import React from 'react';
import { formatXecFromSats } from '../utils/amount';

type AmountDisplayProps = {
  sats: number | string | bigint | null | undefined;
  showSymbol?: boolean;
};

export const AmountDisplay: React.FC<AmountDisplayProps> = ({ sats, showSymbol = true }) => {
  const formatted = formatXecFromSats(sats);
  return <>{showSymbol ? `${formatted} XEC` : formatted}</>;
};
