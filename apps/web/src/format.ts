import type { Expiry } from './types';

export const money = (cents: number) => `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const dateOnly = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');

// Plain-language labels for people. The API strings stay precise for agents.

const noon = (d: string) => Date.parse(`${d.slice(0, 10)}T12:00:00Z`);
const daysBetween = (from: string, to: string) => Math.round((noon(to) - noon(from)) / 86_400_000);
const monthDay = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const weekday = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

/** `today` is the household's date from the API, so labels agree with the server's urgency. */
export function expiryLabel(e: Pick<Expiry, 'on' | 'kind'> | null | undefined, today: string): string {
  if (!e) return 'No date';
  const d = daysBetween(today, e.on);
  const day = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d < 7 ? weekday(e.on) : monthDay(e.on);
  if (e.kind === 'printed') return d < 0 ? `Expired ${d === -1 ? 'yesterday' : `${-d} days ago`}` : `Expires ${day}`;
  if (d < 0) return 'Probably past its best';
  return d <= 1 ? `Best used ${day}` : `Good until about ${day}`;
}

export function expiryNote(e: Expiry | null | undefined): string | null {
  if (!e) return null;
  if (e.kind === 'printed') return 'Date printed on the package';
  return e.confidence === 'low' ? 'A rough guess. Check the package if you can.' : 'Estimated from typical shelf life';
}

/** "1 × 3 lb" reads as "3 lb"; the multiplier only matters for several packages. */
export const amount = (text: string) => (text === 'unknown amount' ? 'Amount unknown' : text.replace(/^(~?)1 × /, '$1'));

/** Receipts shout ("PANTRY CLUB"); people don't. */
export const titleCase = (s: string) =>
  s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s\-/&(.])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase()) : s;

export const ago = (days: number) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);
