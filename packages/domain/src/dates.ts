import type { IsoDate } from './common';

const DAY_MS = 86_400_000;
const toUtc = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`);

export function addDays(d: IsoDate, n: number): IsoDate {
  return new Date(toUtc(d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatShortDate(d: IsoDate, today: IsoDate): string {
  const diff = daysBetween(today, d);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const date = new Date(`${d}T00:00:00Z`);
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}
