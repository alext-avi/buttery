// Only food text, quantities, dates, locations and recipe titles may reach a model.
// Input schemas already strip unknown fields; this redacts personal data that can hide
// inside free text (an agent transcribing a whole receipt, a user signing a note).

const PATTERNS: [RegExp, string][] = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/(\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, '[phone]'],
  [
    // A house number, one to four words, then a street suffix. Excludes `ct`, which
    // collides with receipt counts ("EGGS 24 CT").
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|highway|hwy|parkway|pkwy)\b\.?/gi,
    '[address]',
  ],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Recursively redact every string value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
