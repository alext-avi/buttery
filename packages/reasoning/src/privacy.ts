// Only food text, quantities, dates, locations and recipe titles may reach a model.
// Input schemas already strip unknown fields; this redacts personal data that can hide
// inside free text (an agent transcribing a whole receipt, a user signing a note).

/** Title Case and UPPER CASE variants, so the address pattern can stay case-sensitive. */
const cased = (words: string[]) => words.flatMap((w) => [w, w.toUpperCase(), w[0]!.toUpperCase() + w.slice(1)]);

// No "Ct" or "Way": they collide with receipt counts ("24 CT") and food words.
const STREET_SUFFIXES = cased([
  'street', 'st', 'avenue', 'ave', 'road', 'rd', 'boulevard', 'blvd', 'drive', 'dr', 'lane', 'ln',
  'highway', 'hwy', 'parkway', 'pkwy', 'court', 'place', 'terrace',
]);
// A number followed by one of these is a quantity ("12 OZ", "16 PK", "2 cans"), never a house number.
const UNIT_TOKENS = cased(['oz', 'fl', 'lb', 'lbs', 'ct', 'gal', 'qt', 'pt', 'pk', 'pack', 'can', 'cans', 'kg', 'g', 'ml', 'l', 'ea', 'each', 'count', 'x']);

/**
 * A street address: a house number of 2–6 digits that is not followed by a unit token, one to
 * three capitalized words ("Elm", "NORTH OAK"), then a street suffix. Case-sensitive on purpose,
 * so lowercase food text ("2 cans of Dr Pepper", "3 lb Lane cake") never matches.
 */
const ADDRESS = new RegExp(
  `\\b\\d{2,6}\\s+(?!(?:${UNIT_TOKENS.join('|')})\\b)(?:[A-Z][A-Za-z'.-]*\\s+){1,3}(?:${STREET_SUFFIXES.join('|')})\\b\\.?`,
  'g',
);

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]'],
  [ADDRESS, '[address]'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** `line_id`, `food_id`, `lot_id`, `recipe_id`, `candidate_lot_ids`, …: ids pass through unchanged. */
function isIdKey(key: string): boolean {
  return /(?:^|_)ids?$/.test(key);
}

/** Recursively redact every free-text string value. Id fields are never rewritten. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = isIdKey(k) ? v : redactDeep(v);
    return out as T;
  }
  return value;
}
