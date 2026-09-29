import type { Perishability } from './common';
import { normalizeName, similarity } from './normalize';

export type CatalogFood = {
  id: string;
  name: string;
  normalizedName: string;
  aliases: string[];
  category: string | null;
  perishability: Perishability;
};

export function exactAliasMatch<F extends CatalogFood>(text: string, foods: F[]): F | undefined {
  const n = normalizeName(text);
  return foods.find((f) => f.normalizedName === n || f.aliases.includes(n));
}

export function shortlist<F extends CatalogFood>(text: string, foods: F[], limit = 5, min = 0.2): Array<F & { score: number }> {
  return foods
    .map((f) => ({ ...f, score: Math.max(similarity(text, f.name), ...f.aliases.map((a) => similarity(text, a))) }))
    .filter((f) => f.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
