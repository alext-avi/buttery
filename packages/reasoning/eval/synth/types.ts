import type { CanonicalizeInput } from '../../src/schemas.ts';

export type Scenario = 'hit' | 'alias' | 'lookalike' | 'unrelated' | 'empty';

export interface ExpectedPackage {
  count?: number;
  size: number;
  unit: string;
}

export interface ExpectedLine {
  kind: 'food' | 'coupon' | 'return' | 'non_food';
  food_key?: string;
  line_kind: 'item' | 'coupon' | 'return' | 'non_food';
  /** Accepted canonical names; empty = not scored. */
  names: string[];
  /** Accepted categories; empty = not scored. */
  categories: string[];
  /** null = not scored. */
  package: { accept: ExpectedPackage[]; allowAbsent: boolean } | null;
  /** Accepted match food_ids ('new' allowed); empty = not scored. */
  match: string[];
  scenario: Scenario;
  store: string;
  /** Hand-written case notes. */
  note?: string;
}

export interface EvalCase {
  case_id: string;
  store: string;
  lines: CanonicalizeInput['lines'];
  candidates: NonNullable<CanonicalizeInput['candidates']>;
  expected: Record<string, ExpectedLine>;
}

export interface EvalDataset {
  version: 1;
  split: 'dev' | 'test';
  seed: number;
  generator: string;
  cases: EvalCase[];
}
