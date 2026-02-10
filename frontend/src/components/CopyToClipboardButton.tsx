import React, { useState } from 'react';

interface CopyToClipboardButtonProps {
  text: string;
  idleLabel?: string;
}

export const CopyToClipboardButton: React.FC<CopyToClipboardButtonProps> = ({
  text,
  idleLabel = 'Copiar',
}) => {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const handleCopy = async () => {
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    } finally {
      window.setTimeout(() => setState('idle'), 1500);
    }
  };

  const label = state === 'copied' ? 'Copiado' : state === 'failed' ? 'Error' : idleLabel;

  return (
    <button type="button" onClick={handleCopy} disabled={!text.trim()}>
      {label}
    </button>
  );
};
