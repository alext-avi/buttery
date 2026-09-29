import type { CanonicalizeOutput } from '../../src/schemas.ts';
import { normalizeUnit } from '../../src/text.ts';
import type { ExpectedLine, ExpectedPackage } from './types.ts';

type OutLine = CanonicalizeOutput['lines'][number];

const DROP = new Set(['organic', 'org', 'fresh', 'the', 'of', 'a', 'and', '&']);
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9% ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !DROP.has(t))
    .map((t) => t.replace(/(ies)$/, 'y').replace(/(es|s)$/, ''));
}

/**
 * Strict: same tokens (plural- and "organic"-insensitive).
 * Lenient: every token of an accepted name appears in the answer, so a more specific answer
 * ("granny smith apples" for "apples") passes. Accept lists avoid bare generic names like "milk"
 * that a different food ("2% milk") would also contain.
 */
export function nameMatches(accepted: string[], actual: string): { strict: boolean; lenient: boolean } {
  const a = tokens(actual);
  let strict = false;
  let lenient = false;
  for (const name of accepted) {
    const e = tokens(name);
    const same = e.length === a.length && e.every((t) => a.includes(t));
    strict ||= same;
    lenient ||= same || (e.length > 0 && e.every((t) => a.includes(t)));
  }
  return { strict, lenient };
}

const UNIT_EQUIV: Record<string, string> = { fl_oz: 'oz' };
const unitKey = (u: string | undefined) => {
  const n = normalizeUnit(u);
  return n ? (UNIT_EQUIV[n] ?? n) : undefined;
};

export function packageMatches(spec: NonNullable<ExpectedLine['package']>, actual: OutLine['package']): boolean {
  if (!actual || (actual.size === undefined && actual.count === undefined)) return spec.allowAbsent;
  if (spec.accept.length === 0) return spec.allowAbsent;
  return spec.accept.some((e) => onePackage(e, actual));
}

function onePackage(e: ExpectedPackage, a: NonNullable<OutLine['package']>): boolean {
  const close = (x: number | undefined, y: number) => x !== undefined && Math.abs(x - y) <= Math.max(0.01, y * 0.01);
  const eu = unitKey(e.unit);
  const au = unitKey(a.unit);
  if ((e.count ?? 1) === (a.count ?? 1) && close(a.size, e.size) && eu === au) return true;
  // Counted items: accept count-only (24 CT → count 24) or count × size equivalents.
  if (eu === 'ct') {
    const total = (e.count ?? 1) * e.size;
    if (a.size === undefined && close(a.count, total)) return true;
    if (au === 'ct' && close((a.count ?? 1) * (a.size ?? 0), total)) return true;
  }
  return false;
}

export interface LineScore {
  line_kind: boolean;
  name?: { strict: boolean; lenient: boolean };
  category?: boolean;
  package?: boolean;
  match?: { ok: boolean; wrongMatch: boolean; missedMatch: boolean; confidence: string; predicted: string };
}

export function scoreLine(exp: ExpectedLine, out: OutLine): LineScore {
  const s: LineScore = { line_kind: out.line_kind === exp.line_kind };
  if (exp.names.length) s.name = nameMatches(exp.names, out.canonical_name);
  if (exp.categories.length) s.category = exp.categories.includes(out.category);
  if (exp.package) s.package = packageMatches(exp.package, out.package);
  if (exp.match.length) {
    const predicted = out.match.food_id;
    const ok = exp.match.includes(predicted);
    s.match = {
      ok,
      // Attached to a food that isn't an accepted answer: the dangerous error.
      wrongMatch: predicted !== 'new' && !ok,
      // Said "new" although the food exists in the household.
      missedMatch: predicted === 'new' && !ok,
      confidence: out.match.confidence,
      predicted,
    };
  }
  return s;
}

export interface Summary {
  lines: number;
  line_kind: [number, number];
  name_strict: [number, number];
  name_lenient: [number, number];
  category: [number, number];
  package: [number, number];
  match: [number, number];
  wrong_match: [number, number];
  missed_match: [number, number];
  high_conf_match_precision: [number, number];
  /** Precision of existing-food matches, by the model's confidence. */
  match_precision_by_conf: Record<string, [number, number]>;
  by_scenario: Record<string, [number, number]>;
}

export function summarize(rows: { exp: ExpectedLine; score: LineScore }[]): Summary {
  const t = (): [number, number] => [0, 0];
  const s: Summary = {
    lines: rows.length,
    line_kind: t(), name_strict: t(), name_lenient: t(), category: t(), package: t(), match: t(),
    wrong_match: t(), missed_match: t(), high_conf_match_precision: t(), match_precision_by_conf: {}, by_scenario: {},
  };
  const inc = (pair: [number, number], ok: boolean) => {
    pair[1]++;
    if (ok) pair[0]++;
  };
  for (const { exp, score } of rows) {
    inc(s.line_kind, score.line_kind);
    if (score.name) {
      inc(s.name_strict, score.name.strict);
      inc(s.name_lenient, score.name.lenient);
    }
    if (score.category !== undefined) inc(s.category, score.category);
    if (score.package !== undefined) inc(s.package, score.package);
    if (score.match) {
      inc(s.match, score.match.ok);
      inc(s.wrong_match, score.match.wrongMatch);
      inc(s.missed_match, score.match.missedMatch);
      // Of matches to an existing food made with high confidence, how many were right?
      if (score.match.confidence === 'high' && score.match.predicted !== 'new') inc(s.high_conf_match_precision, score.match.ok);
      if (score.match.predicted !== 'new') inc((s.match_precision_by_conf[score.match.confidence] ??= t()), score.match.ok);
      inc((s.by_scenario[exp.scenario] ??= t()), score.match.ok);
    }
  }
  return s;
}

export const pct = ([ok, n]: [number, number]) => (n === 0 ? '  n/a' : `${((100 * ok) / n).toFixed(1).padStart(5)}%`);
