// Live canonicalizeItems demo against Crusoe.
//
//   npm run demo -w packages/reasoning                               # paste lines, then Ctrl-D
//   npm run demo -w packages/reasoning -- "KS ORG EGGS 24CT" "GV 2PCT MILK HG"
//   npm run demo -w packages/reasoning -- --file scripts/demo-receipt.txt
//   npm run demo -w packages/reasoning -- --file scripts/demo-receipt.txt --compare
//
// Flags: --file <path>  --no-household  --compare (also run the offline fallback)  --why (rationales)
//        --model <id>  --json
//
// Each line may end with a column-separated price ("   5.99", "   2.00-"), which is sent as price_cents. Lines are
// matched against a small sample household, shortlisted the way the server would (alias and
// trigram similarity), so the demo shows matching as well as naming, units and line kinds.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  createFallbackProvider,
  createReasoningProvider,
  toBaseQuantity,
  type CanonicalizeInput,
  type CanonicalizeOutput,
  type ReasoningResult,
} from '../src/index.ts';
import { normalizeName, trigramSimilarity } from '../src/text.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string' },
    'no-household': { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
    why: { type: 'boolean', default: false },
    model: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});

// --- input ---
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) console.error('Paste receipt lines, then press Ctrl-D:\n');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const text = values.file ? readFileSync(values.file, 'utf8') : positionals.length ? positionals.join('\n') : await readStdin();
const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (rawLines.length === 0) {
  console.error('No lines given.');
  process.exit(1);
}

const lines: CanonicalizeInput['lines'] = rawLines.map((line, i) => {
  // A trailing price such as "5.99", "-2.00" or "2.00-" becomes price_cents.
  const m = /\s{2,}(-?\d+\.\d{2})(-?)\s*$/.exec(line); // column-separated prices only
  const raw_text = m ? line.slice(0, m.index).trim() : line;
  const price = m ? Math.round(Number(m[1]) * 100) * (m[2] === '-' ? -1 : 1) : undefined;
  return { line_id: `L${i + 1}`, raw_text, ...(price !== undefined ? { price_cents: price } : {}) };
});

// --- sample household: what the server would have in `foods` ---
type Candidate = NonNullable<CanonicalizeInput['candidates']>[string][number];
const HOUSEHOLD: Candidate[] = [
  { food_id: 'food_whole_milk', name: 'whole milk', aliases: ['KS WHOLE MILK 1 GAL'], category: 'dairy', perishability: 'perishable' },
  { food_id: 'food_2pct_milk', name: '2% milk', aliases: [], category: 'dairy', perishability: 'perishable' },
  { food_id: 'food_eggs', name: 'eggs', aliases: ['KS ORG EGGS 24CT'], category: 'eggs', perishability: 'perishable' },
  { food_id: 'food_chicken_breast', name: 'chicken breast', aliases: ['KS BNLS SKNLS BREAST'], category: 'poultry', perishability: 'perishable' },
  { food_id: 'food_chicken_thighs', name: 'chicken thighs', aliases: [], category: 'poultry', perishability: 'perishable' },
  { food_id: 'food_greek_yogurt', name: 'greek yogurt', aliases: [], category: 'dairy', perishability: 'perishable' },
  { food_id: 'food_baby_spinach', name: 'baby spinach', aliases: [], category: 'leafy_greens', perishability: 'perishable' },
  { food_id: 'food_spring_mix', name: 'spring mix', aliases: [], category: 'leafy_greens', perishability: 'perishable' },
  { food_id: 'food_strawberries', name: 'strawberries', aliases: [], category: 'berries', perishability: 'perishable' },
  { food_id: 'food_bananas', name: 'bananas', aliases: [], category: 'fruit', perishability: 'perishable' },
  { food_id: 'food_rice', name: 'jasmine rice', aliases: [], category: 'grains_pasta', perishability: 'shelf_stable' },
  { food_id: 'food_penne', name: 'penne', aliases: [], category: 'grains_pasta', perishability: 'shelf_stable' },
  { food_id: 'food_marinara', name: 'marinara sauce', aliases: [], category: 'sauces', perishability: 'shelf_stable' },
  { food_id: 'food_cheddar', name: 'shredded cheddar', aliases: [], category: 'cheese', perishability: 'perishable' },
  { food_id: 'food_butter', name: 'butter', aliases: [], category: 'dairy', perishability: 'perishable' },
  { food_id: 'food_pb', name: 'peanut butter', aliases: [], category: 'condiments', perishability: 'shelf_stable' },
];

/** Server-style shortlist: exact alias first, then the top trigram matches on name and aliases. */
function shortlist(raw: string): Candidate[] {
  const scored = HOUSEHOLD.map((c) => {
    const aliases = c.aliases ?? [];
    const names = [c.name, ...aliases];
    const exact = aliases.some((a) => normalizeName(a) === normalizeName(raw));
    const score = exact ? 2 : Math.max(...names.map((n) => trigramSimilarity(n, raw)));
    return { c, score };
  });
  return scored.filter((s) => s.score >= 0.12).sort((a, b) => b.score - a.score).slice(0, 4).map((s) => s.c);
}

const candidates: NonNullable<CanonicalizeInput['candidates']> = {};
if (!values['no-household']) for (const l of lines) {
  const list = shortlist(l.raw_text);
  if (list.length) candidates[l.line_id] = list;
}

// --- run ---
const crusoe = createReasoningProvider({ ...(values.model ? { model: values.model } : {}) });
const input = { lines, candidates };
const result = await crusoe.canonicalizeItems(input);
const offline = values.compare ? await createFallbackProvider().canonicalizeItems(input) : undefined;

if (values.json) {
  console.log(JSON.stringify({ input, result, ...(offline ? { fallback: offline } : {}) }, null, 2));
  process.exit(result.path === 'fallback' && result.call.provider !== 'fallback' ? 1 : 0);
}

// --- render ---
const tty = process.stdout.isTTY;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => c('2', s);
const bold = (s: string) => c('1', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const red = (s: string) => c('31', s);
const cyan = (s: string) => c('36', s);
const pad = (s: string, n: number) => {
  // eslint-disable-next-line no-control-regex
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  return visible >= n ? s : s + ' '.repeat(n - visible);
};

type Line = CanonicalizeOutput['lines'][number];

function fmtPackage(l: Line): string {
  if (!l.package) return dim('—');
  const p = l.package;
  const printed = `${p.count ? `${p.count}×` : ''}${p.size ?? ''} ${p.unit ?? ''}`.trim();
  const base = toBaseQuantity(p);
  return base && p.unit !== base.unit ? `${printed} ${dim(`(${Math.round(base.amount)} ${base.unit})`)}` : printed;
}

function fmtMatch(l: Line): string {
  const conf = l.match.confidence;
  const tint = conf === 'high' ? green : conf === 'medium' ? yellow : red;
  if (l.match.food_id === 'new') return `${cyan('new')} ${dim(conf)}`;
  const name = HOUSEHOLD.find((h) => h.food_id === l.match.food_id)?.name ?? l.match.food_id;
  return `${tint(`→ ${name}`)} ${dim(conf)}`;
}

function fmtKind(k: Line['line_kind']): string {
  return k === 'item' ? dim('item') : k === 'coupon' ? yellow('coupon') : k === 'return' ? yellow('return') : dim('non-food');
}

function table(r: ReasoningResult<CanonicalizeOutput>, title: string) {
  const call = r.call;
  const pathTint = r.path === 'fallback' ? red : green;
  console.log(`\n${bold(title)}  ${dim(`${call.provider}${call.model ? ` · ${call.model}` : ''}`)}  path ${pathTint(r.path)}  ${dim(`${call.latencyMs} ms`)}${call.tokensOut ? dim(` · ${call.tokensIn} in / ${call.tokensOut} out`) : ''}${cost(call) ?? ''}`);
  if (call.error) console.log(red(`  error: ${call.error.slice(0, 200)}`));
  const w = Math.min(34, Math.max(14, ...lines.map((l) => l.raw_text.length)) + 2);
  const nw = Math.min(36, Math.max(16, ...r.output.lines.map((o) => o.canonical_name.length)) + 2);
  const cw = Math.max(10, ...r.output.lines.map((o) => o.category.length)) + 2;
  console.log(dim(`  ${pad('receipt line', w)}${pad('canonical name', nw)}${pad('category', cw)}${pad('package', 20)}${pad('kind', 10)}match`));
  for (const l of lines) {
    const o = r.output.lines.find((x) => x.line_id === l.line_id)!;
    console.log(`  ${pad(l.raw_text.slice(0, w - 2), w)}${pad(bold(o.canonical_name.slice(0, nw - 2)), nw)}${pad(o.category, cw)}${pad(fmtPackage(o), 20)}${pad(fmtKind(o.line_kind), 10)}${fmtMatch(o)}`);
    if (values.why) console.log(dim(`  ${' '.repeat(w)}${o.rationale}`));
  }
  if (r.violations.length) {
    console.log(dim('\n  standards and guardrails applied:'));
    for (const v of r.violations) console.log(dim(`   • ${v.replace(/^canonicalizeItems: /, '')}`));
  }
}

function cost(call: ReasoningResult<unknown>['call']): string | undefined {
  const prices: Record<string, [number, number]> = { 'deepseek-ai/Deepseek-V4-Flash': [0.14, 0.28], 'deepseek-ai/DeepSeek-V4-Pro': [1.74, 3.48], 'openai/gpt-oss-120b': [0.05, 0.2] };
  const p = call.model ? prices[call.model] : undefined;
  if (!p || call.tokensIn === null || call.tokensOut === null) return undefined;
  return dim(` · $${((call.tokensIn * p[0] + call.tokensOut * p[1]) / 1e6).toFixed(5)}`);
}

table(result, 'Crusoe');
if (offline) table(offline, 'Offline fallback (no model)');
if (!values['no-household']) console.log(dim(`\n  matched against a sample household of ${HOUSEHOLD.length} foods; --no-household to skip`));
console.log();
process.exitCode = result.path === 'fallback' && result.call.provider !== 'fallback' ? 1 : 0;
