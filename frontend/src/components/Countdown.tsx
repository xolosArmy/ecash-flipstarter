import React, { useEffect, useMemo, useState } from 'react';

type CountdownProps = {
  expiresAt: string;
};

function formatRemaining(expiresAt: string, now: number): string {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return 'Expirada';
  const remainingMs = expiresAtMs - now;
  if (remainingMs <= 0) return 'Expirada';

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);

  if (days === 0 && hours === 0) {
    const minutes = Math.max(0, totalMinutes);
    return `${minutes}m restantes`;
  }

  return `${days}d ${hours}h restantes`;
}

export const Countdown: React.FC<CountdownProps> = ({ expiresAt }) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const label = useMemo(() => formatRemaining(expiresAt, now), [expiresAt, now]);

  return <>{label}</>;
};
