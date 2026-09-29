// npm run reasoning:ping — one tiny estimateShelfLife call against the configured provider.
// Exits non-zero unless the result came from the model (path "model" or "repair").
import { createReasoningProvider } from '../src/index.ts';

const provider = createReasoningProvider();
const result = await provider.estimateShelfLife({
  food_name: 'whole milk',
  category: 'dairy',
  states: ['sealed', 'opened'],
  location: 'fridge',
});

console.log(`provider: ${result.call.provider}`);
console.log(`model:    ${result.call.model ?? '(none)'}`);
console.log(`path:     ${result.path}`);
console.log(`latency:  ${result.call.latencyMs} ms`);
console.log(`tokens:   ${result.call.tokensIn ?? '-'} in / ${result.call.tokensOut ?? '-'} out`);
if (result.call.error) console.log(`error:    ${result.call.error}`);
if (result.violations.length) console.log(`violations:\n  ${result.violations.join('\n  ')}`);
console.log(JSON.stringify(result.output, null, 2));

if (result.path !== 'model' && result.path !== 'repair') {
  console.error(`\nping failed: expected path "model" or "repair", got "${result.path}"`);
  process.exit(1);
}
