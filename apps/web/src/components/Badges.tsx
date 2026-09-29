import { expiryLabel, expiryNote } from '../format';
import type { Confidence, Expiry, Urgency } from '../types';

/** Mirrors the receipt verdict: low → "Check this", medium → "Worth a glance", high → nothing. */
export function ConfidenceBadge({ value }: { value: Confidence }) {
  if (value === 'low') return <span className="badge conf-low">Check this</span>;
  if (value === 'medium') return <span className="badge conf-medium">Worth a glance</span>;
  return null;
}

export function ExpiryBadge({ expires, urgency, today }: { expires: Expiry | Pick<Expiry, 'on' | 'kind'> | null; urgency?: Urgency | null; today: string }) {
  return (
    <span className={`expiry ${urgency ?? ''}`} title={expires && 'confidence' in expires ? (expiryNote(expires) ?? undefined) : undefined}>
      {expiryLabel(expires, today)}
    </span>
  );
}
