// npm run reasoning:eval:synth -- [--split dev|test] [--limit N] [--model X] [--provider fallback]
//                                  [--max-tokens N] [--concurrency N] [--failures N] [--no-cache] [--out file.json]
//
// Scores canonicalizeItems on the synthetic receipts in eval/data (built by eval/synth/generate.ts).
// Each receipt is one batched call, as in production. Spend is bounded by --max-tokens (default
// 150k in+out). Results are cached on disk by model + prompt version + input, so re-scoring is free.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createReasoningProvider, type ReasoningCache } from '../src/index.ts';
import { outputJsonSchema } from '../src/engine.ts';
import { systemPrompt } from '../src/prompts.ts';
import { pct, scoreLine, summarize, type LineScore } from '../eval/synth/score.ts';
import type { EvalDataset, ExpectedLine } from '../eval/synth/types.ts';

const { values } = parseArgs({
  options: {
    split: { type: 'string', default: 'dev' },
    limit: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    'max-tokens': { type: 'string', default: '150000' },
    concurrency: { type: 'string', default: '2' },
    failures: { type: 'string', default: '25' },
    'no-cache': { type: 'boolean', default: false },
    out: { type: 'string' },
    only: { type: 'string' },
  },
});

// Flash prices from crusoe.ai/cloud/pricing (USD per 1M tokens), for the spend estimate.
const PRICES: Record<string, [number, number]> = {
  'deepseek-ai/Deepseek-V4-Flash': [0.14, 0.28],
  'deepseek-ai/DeepSeek-V4-Pro': [1.74, 3.48],
  'openai/gpt-oss-120b': [0.05, 0.2],
};

const data = JSON.parse(readFileSync(new URL(`../eval/data/synth-${values.split}.json`, import.meta.url), 'utf8')) as EvalDataset;
// --only hand | synth: the hand-written cases or the generated ones.
const filtered = data.cases.filter((c) => !values.only || (values.only === 'hand') === c.case_id.startsWith('hand-'));
const cases = values.limit ? filtered.slice(0, Number(values.limit)) : filtered;

// Disk cache: prompt/schema changes produce new keys, so a stale answer is never replayed.
// Cached outputs are post-guardrail, so guardrail and text-helper code is part of the version too.
const codeFiles = ['../src/guardrails.ts', '../src/text.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('');
const promptVersion = createHash('sha256')
  .update(systemPrompt('canonicalizeItems') + JSON.stringify(outputJsonSchema('canonicalizeItems')) + codeFiles)
  .digest('hex')
  .slice(0, 12);
const cacheDir = new URL('../eval/.cache/', import.meta.url);
mkdirSync(cacheDir, { recursive: true });
const fileCache: ReasoningCache = {
  async get(key) {
    const f = new URL(`${createHash('sha256').update(`${promptVersion}:${key}`).digest('hex')}.json`, cacheDir);
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : undefined;
  },
  async set(key, value) {
    const f = new URL(`${createHash('sha256').update(`${promptVersion}:${key}`).digest('hex')}.json`, cacheDir);
    writeFileSync(f, JSON.stringify(value));
  },
};

const provider = createReasoningProvider({
  ...(values.provider === 'fallback' ? { provider: 'fallback' as const } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values['no-cache'] ? {} : { cache: fileCache }),
});

const maxTokens = Number(values['max-tokens']);
let tokensIn = 0;
let tokensOut = 0;
let model: string | null = null;
const paths: Record<string, number> = {};
const errors: string[] = [];
const rows: { exp: ExpectedLine; score: LineScore; raw: string; out: unknown; caseId: string }[] = [];
let stopped = false;
let latencyTotal = 0;
let latencyCalls = 0;

async function runCase(c: EvalDataset['cases'][number]) {
  if (tokensIn + tokensOut >= maxTokens) {
    stopped = true;
    return;
  }
  const result = await provider.canonicalizeItems({ lines: c.lines, candidates: c.candidates });
  model = result.call.model;
  paths[result.path] = (paths[result.path] ?? 0) + 1;
  tokensIn += result.call.tokensIn ?? 0;
  tokensOut += result.call.tokensOut ?? 0;
  if (result.path === 'model' || result.path === 'repair') {
    latencyTotal += result.call.latencyMs;
    latencyCalls++;
  }
  if (result.call.error) errors.push(`${c.case_id}: ${result.call.error.slice(0, 160)}`);
  for (const line of c.lines) {
    const out = result.output.lines.find((l) => l.line_id === line.line_id)!;
    const exp = c.expected[line.line_id]!;
    rows.push({ exp, score: scoreLine(exp, out), raw: line.raw_text, out, caseId: c.case_id });
  }
}

const queue = [...cases];
await Promise.all(
  Array.from({ length: Number(values.concurrency) }, async () => {
    while (queue.length) await runCase(queue.shift()!);
  }),
);

const s = summarize(rows);
const price = model ? PRICES[model] : undefined;
const cost = price ? (tokensIn * price[0] + tokensOut * price[1]) / 1e6 : null;

console.log(`split=${values.split} model=${model ?? '(fallback)'} prompt=${promptVersion} receipts=${cases.length} lines=${s.lines}`);
console.log(`paths ${JSON.stringify(paths)}  tokens ${tokensIn} in / ${tokensOut} out${cost !== null ? `  ≈ $${cost.toFixed(4)}` : ''}${latencyCalls ? `  avg latency ${Math.round(latencyTotal / latencyCalls)} ms/receipt` : ''}`);
if (stopped) console.log(`STOPPED: token budget ${maxTokens} reached; later receipts not scored`);
for (const e of errors.slice(0, 5)) console.log(`  error ${e}`);
console.log(`
  line_kind            ${pct(s.line_kind)}  (${s.line_kind.join('/')})
  canonical_name       ${pct(s.name_strict)} strict, ${pct(s.name_lenient)} lenient  (${s.name_lenient.join('/')})
  category             ${pct(s.category)}  (${s.category.join('/')})
  package              ${pct(s.package)}  (${s.package.join('/')})
  match accuracy       ${pct(s.match)}  (${s.match.join('/')})
    wrong match        ${pct(s.wrong_match)}  ← attached to the wrong food (dangerous)
    missed match       ${pct(s.missed_match)}  ← said "new" but the food exists
    high-conf precision${pct(s.high_conf_match_precision)}  (${s.high_conf_match_precision.join('/')})
  match precision by confidence  ${Object.entries(s.match_precision_by_conf).map(([k, v]) => `${k} ${pct(v).trim()} (${v.join('/')})`).join('  ')}
  match by scenario    ${Object.entries(s.by_scenario).map(([k, v]) => `${k} ${pct(v).trim()} (${v.join('/')})`).join('  ')}`);

const failures = rows.filter(
  (r) => !r.score.line_kind || r.score.name?.lenient === false || r.score.category === false || r.score.package === false || r.score.match?.ok === false,
);
const nFail = Number(values.failures);
if (nFail > 0 && failures.length) {
  console.log(`\nfailures (${failures.length} lines, showing ${Math.min(nFail, failures.length)}):`);
  for (const f of failures.slice(0, nFail)) {
    const o = f.out as any;
    const bad = [
      !f.score.line_kind && `kind=${o.line_kind}≠${f.exp.line_kind}`,
      f.score.name?.lenient === false && `name="${o.canonical_name}"≠"${f.exp.names[0]}"`,
      f.score.category === false && `cat=${o.category}≠${f.exp.categories.join('|')}`,
      f.score.package === false && `pkg=${JSON.stringify(o.package ?? null)}≠${JSON.stringify(f.exp.package?.accept[0] ?? null)}`,
      f.score.match?.ok === false && `match=${o.match.food_id}(${o.match.confidence})≠${f.exp.match.join('|')} [${f.exp.scenario}]`,
    ].filter(Boolean);
    console.log(`  ${f.raw.padEnd(34)} ${bad.join('  ')}${f.exp.note ? `   // ${f.exp.note}` : ''}`);
  }
}

if (values.out) writeFileSync(values.out, JSON.stringify({ model, promptVersion, split: values.split, summary: s, tokensIn, tokensOut, cost, paths }, null, 2));
