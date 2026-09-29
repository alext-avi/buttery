import { expiryLabel, expiryNote } from '../format';
import type { Confidence, Expiry, Urgency } from '../types';

export function ConfidenceBadge({ value }: { value: Confidence }) {
  return value === 'low' ? <span className="badge conf-low">Check this</span> : null;
}

export function ExpiryBadge({ expires, urgency, today }: { expires: Expiry | Pick<Expiry, 'on' | 'kind'> | null; urgency?: Urgency | null; today: string }) {
  return (
    <span className={`expiry ${urgency ?? ''}`} title={expires && 'confidence' in expires ? (expiryNote(expires) ?? undefined) : undefined}>
      {expiryLabel(expires, today)}
    </span>
  );
}
