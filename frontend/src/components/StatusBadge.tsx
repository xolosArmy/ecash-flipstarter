import React from 'react';

type StatusBadgeProps = {
  status: string;
};

const STATUS_MAP: Record<string, { label: string; bg: string; color: string }> = {
  draft: { label: 'Draft', bg: '#d1d5db', color: '#1f2937' },
  pending_fee: { label: 'Pending fee', bg: '#fef3c7', color: '#92400e' },
  active: { label: 'Active', bg: '#dcfce7', color: '#166534' },
  funded: { label: 'Funded', bg: '#dbeafe', color: '#1d4ed8' },
  expired: { label: 'Expired', bg: '#fee2e2', color: '#991b1b' },
  paid_out: { label: 'Paid out', bg: '#e0e7ff', color: '#3730a3' },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const config = STATUS_MAP[status] || { label: status, bg: '#e5e7eb', color: '#111827' };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: '0.86rem',
        fontWeight: 700,
        background: config.bg,
        color: config.color,
      }}
    >
      {config.label}
    </span>
  );
};
