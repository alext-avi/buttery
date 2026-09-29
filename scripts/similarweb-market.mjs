// Pull a small market snapshot from the Similarweb API (v1 REST) for the pitch deck.
//   node --env-file=.env scripts/similarweb-market.mjs > docs/market/similarweb-2026-08.json
// Needs SIMILARWEB_API_KEY. About 3 calls per domain; keep the domain list short.
const KEY = process.env.SIMILARWEB_API_KEY;
if (!KEY) throw new Error('SIMILARWEB_API_KEY missing');
const START = process.env.SW_START ?? '2026-06';
const END = process.env.SW_END ?? '2026-08';

const DOMAINS = {
  'meal planning and recipe apps': ['mealime.com', 'paprikaapp.com', 'samsungfood.com', 'plantoeat.com', 'supercook.com', 'eatthismuch.com'],
  'shopping lists and household organizers': ['anylist.com', 'ourgroceries.com', 'cozi.com', 'out-of-milk.com'],
  'shelf-life lookups (the question Buttery answers)': ['stilltasty.com', 'eatbydate.com'],
  'recipe demand and grocery context': ['allrecipes.com', 'supercook.com', 'instacart.com'],
};
const METRICS = ['visits', 'average-visit-duration', 'bounce-rate'];

async function get(domain, metric) {
  const url = new URL(`https://api.similarweb.com/v1/website/${domain}/total-traffic-and-engagement/${metric}`);
  for (const [k, v] of Object.entries({ api_key: KEY, start_date: START, end_date: END, country: 'world', granularity: 'monthly', main_domain_only: 'false', format: 'json' })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: `${res.status} ${body?.meta?.error_message ?? ''}`.trim() };
  const key = metric === 'visits' ? 'visits' : metric === 'bounce-rate' ? 'bounce_rate' : 'average_visit_duration';
  return { series: (body[key] ?? []).map((p) => ({ date: p.date, value: p[key] })), last_updated: body.meta?.last_updated };
}

const seen = new Map();
const out = { source: 'Similarweb API v1 (total-traffic-and-engagement), country=world, all devices, main_domain_only=false', period: `${START}..${END}`, pulled_at: new Date().toISOString(), groups: {} };
for (const [group, domains] of Object.entries(DOMAINS)) {
  out.groups[group] = [];
  for (const domain of domains) {
    if (!seen.has(domain)) {
      const row = { domain };
      for (const m of METRICS) row[m] = await get(domain, m);
      seen.set(domain, row);
    }
    out.groups[group].push(seen.get(domain));
  }
}
console.log(JSON.stringify(out, null, 1));
