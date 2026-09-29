import { describe, expect, it } from 'vitest';
import { exactAliasMatch, normalizeName, shortlist, similarity, type CatalogFood } from '../src';

const food = (id: string, name: string, aliases: string[] = []): CatalogFood => ({
  id, name, normalizedName: normalizeName(name), aliases, category: null, perishability: 'perishable',
});

describe('matching', () => {
  it('normalizes case, punctuation and accents', () => {
    expect(normalizeName('  Jalapeño  PEPPERS, 2-LB ')).toBe('jalapeno peppers 2 lb');
  });

  it('scores similar names higher', () => {
    expect(similarity('BABY SPINACH 5 OZ', 'Baby spinach')).toBeGreaterThan(similarity('BABY SPINACH 5 OZ', 'Whole milk'));
  });

  it('matches exact names and learned aliases', () => {
    const foods = [food('1', 'Whole milk', ['whole milk 1 gal']), food('2', 'Eggs')];
    expect(exactAliasMatch('WHOLE MILK 1 GAL', foods)?.id).toBe('1');
    expect(exactAliasMatch('eggs', foods)?.id).toBe('2');
    expect(exactAliasMatch('EGGS 24 CT', foods)).toBeUndefined();
  });

  it('shortlists plausible candidates, best first', () => {
    const foods = [food('1', 'Whole milk'), food('2', 'Baby spinach'), food('3', 'Strawberries')];
    const list = shortlist('BABY SPINACH 5 OZ', foods);
    expect(list[0]?.id).toBe('2');
    expect(list.every((c) => c.score >= 0.2)).toBe(true);
  });

  it('keeps look-alike foods on the shortlist so the model can tell them apart', () => {
    const foods = [food('1', 'whole milk'), food('2', '2% milk'), food('3', 'strawberries')];
    const ids = shortlist('2% MILK 1 GAL', foods).map((c) => c.id);
    expect(ids).toContain('1');
    expect(ids).toContain('2');
  });
});
