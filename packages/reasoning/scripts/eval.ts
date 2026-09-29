// npm run reasoning:eval [-- --model X]
// Runs the fixture receipt lines through canonicalizeItems (empty candidate lists) and scores
// canonical_name, category, line_kind and package against the expected values.
//
// Evaluation rule (tests/fixtures/food-images/README.md): the model sees ONLY the raw receipt line
// text. Expected values, annotations, the manifest and the evaluator-side category key below never
// leave this script.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createReasoningProvider, type CanonicalizeOutput } from '../src/index.ts';
import { normalizeUnit } from '../src/text.ts';

const { values } = parseArgs({ options: { model: { type: 'string' }, json: { type: 'boolean' } } });

interface ExpectedRow {
  raw: string;
  item?: string;
  kind: 'food_purchase' | 'discount' | 'non_food_purchase' | 'return';
  package_count?: number;
  package_size?: { quantity: number; unit: string };
}

const fixture = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/food-images/sources/expected-text.json', import.meta.url), 'utf8'),
) as { receipts: Record<string, { rows: ExpectedRow[] }> };

// Evaluator-side key: the fixture has no category field, so these are ours (alternates accepted).
const EXPECTED_CATEGORY: Record<string, string[]> = {
  'whole milk': ['dairy'],
  milk: ['dairy'],
  eggs: ['eggs'],
  'baby spinach': ['leafy_greens'],
  strawberries: ['berries'],
  'chicken breast': ['poultry'],
  'greek yogurt': ['dairy'],
  bananas: ['fruit'],
  'cherry tomatoes': ['vegetables', 'fruit'],
  'canned chickpeas': ['canned_goods'],
  'paper towels': ['non_food'],
};
const EXPECTED_KIND = { food_purchase: 'item', discount: 'coupon', non_food_purchase: 'non_food', return: 'return' } as const;
const FIXTURE_UNITS: Record<string, string> = { US_gal: 'gal', oz_mass: 'oz', lb: 'lb', count: 'ct' };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (s: string) => new Set(norm(s).split(' ').map((t) => t.replace(/(es|s)$/, '')));

function nameScore(expected: string, actual: string): { strict: boolean; lenient: boolean } {
  const strict = norm(expected) === norm(actual);
  const [e, a] = [tokens(expected), tokens(actual)];
  const lenient = strict || [...e].every((t) => a.has(t)) || [...a].every((t) => e.has(t));
  return { strict, lenient };
}

function packageScore(row: ExpectedRow, actual: CanonicalizeOutput['lines'][number]['package']): boolean {
  const expected = row.package_size!;
  const unit = FIXTURE_UNITS[expected.unit] ?? expected.unit;
  const got = { count: actual?.count, size: actual?.size, unit: normalizeUnit(actual?.unit) };
  if ((row.package_count ?? 1) !== (got.count ?? 1)) {
    // Counted items may be expressed as count alone ("24 CT" → count 24).
    if (!(unit === 'ct' && got.count === expected.quantity && got.size === undefined)) return false;
    return true;
  }
  return got.size === expected.quantity && got.unit === unit;
}

const provider = createReasoningProvider(values.model ? { model: values.model } : {});
type Score = { field: string; ok: boolean };
const scores: Score[] = [];
const rows: string[] = [];
let model: string | null = null;
let fellBack = false;
let totalLatency = 0;

for (const [receiptKey, receipt] of Object.entries(fixture.receipts)) {
  const lines = receipt.rows.map((row, i) => ({ line_id: `${receiptKey}-${i}`, raw_text: row.raw }));
  const result = await provider.canonicalizeItems({ lines, candidates: {} });
  model = result.call.model;
  totalLatency += result.call.latencyMs;
  if (result.path === 'fallback') fellBack = true;
  rows.push(`\n${receiptKey}: path=${result.path} latency=${result.call.latencyMs}ms tokens=${result.call.tokensIn ?? '-'}/${result.call.tokensOut ?? '-'}${result.call.error ? ` error=${result.call.error}` : ''}`);

  receipt.rows.forEach((row, i) => {
    const out = result.output.lines.find((l) => l.line_id === `${receiptKey}-${i}`)!;
    const marks: string[] = [];
    const push = (field: string, ok: boolean, detail: string) => {
      scores.push({ field, ok });
      marks.push(`${ok ? '✓' : '✗'} ${field}=${detail}`);
    };

    push('line_kind', out.line_kind === EXPECTED_KIND[row.kind], out.line_kind);
    const nameKey = row.item ?? (row.kind === 'non_food_purchase' ? 'paper towels' : undefined);
    if (row.item) {
      const s = nameScore(row.item, out.canonical_name);
      push('canonical_name', s.strict, `"${out.canonical_name}"`);
      scores.push({ field: 'canonical_name_lenient', ok: s.lenient });
    }
    if (nameKey && EXPECTED_CATEGORY[nameKey.toLowerCase()]) {
      push('category', EXPECTED_CATEGORY[nameKey.toLowerCase()]!.includes(out.category), out.category);
    }
    if (row.package_size) push('package', packageScore(row, out.package), JSON.stringify(out.package ?? null));
    rows.push(`  ${row.raw.padEnd(24)} ${marks.join('  ')}`);
  });
}

const fields = ['canonical_name', 'canonical_name_lenient', 'category', 'line_kind', 'package'];
const summary = Object.fromEntries(
  fields.map((field) => {
    const s = scores.filter((x) => x.field === field);
    return [field, { correct: s.filter((x) => x.ok).length, total: s.length }];
  }),
);
const scored = scores.filter((s) => s.field !== 'canonical_name_lenient');
const overall = { correct: scored.filter((s) => s.ok).length, total: scored.length };

console.log(`model: ${model ?? '(fallback)'}`);
console.log(rows.join('\n'));
console.log('\naccuracy');
for (const [field, { correct, total }] of Object.entries(summary)) {
  console.log(`  ${field.padEnd(24)} ${correct}/${total}  ${((100 * correct) / total).toFixed(0)}%`);
}
console.log(`  ${'overall'.padEnd(24)} ${overall.correct}/${overall.total}  ${((100 * overall.correct) / overall.total).toFixed(0)}%`);
console.log(`  total latency            ${totalLatency} ms`);
if (values.json) console.log(JSON.stringify({ model, summary, overall, totalLatency, fellBack }));

if (fellBack) {
  console.error('\nnote: at least one receipt used the fallback path; scores above are not model accuracy');
  process.exitCode = 1;
}
