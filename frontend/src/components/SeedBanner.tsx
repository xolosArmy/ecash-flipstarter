import React, { useEffect, useState } from 'react';

const DISMISS_KEY = 'teyolia:dismissedSeedBanner';

export const SeedBanner: React.FC = () => {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === 'true');
  }, []);

  if (dismissed) return null;

  return (
    <aside className="seed-banner" role="status" aria-live="polite">
      <span>Nunca escribas tu seed.</span>
      <button
        type="button"
        className="seed-banner-dismiss"
        onClick={() => {
          localStorage.setItem(DISMISS_KEY, 'true');
          setDismissed(true);
        }}
        aria-label="Cerrar aviso"
      >
        Cerrar
      </button>
    </aside>
  );
};
