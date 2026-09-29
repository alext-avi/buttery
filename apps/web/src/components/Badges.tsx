import type { Confidence, Urgency } from '../types';

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return <span className={`badge conf-${value}`}>{value === 'low' ? 'Check this' : `${value} confidence`}</span>;
}

export function ExpiryBadge({ text, urgency, kind }: { text: string; urgency?: Urgency | null; kind?: 'printed' | 'estimated' }) {
  const title = kind === 'estimated' ? 'Estimated expiry' : kind === 'printed' ? 'Printed on the package' : undefined;
  return (
    <span className={`expiry ${urgency ?? ''}`} title={title}>
      {text}
    </span>
  );
}
