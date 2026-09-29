import { z } from 'zod';
import { FOOD_CATEGORIES, FOOD_STATES } from './shelfLifeDefaults.ts';

// Field names are snake_case to match the spec's JSON. Input schemas strip unknown keys,
// which is also the first privacy guardrail: only the fields below ever reach a model.

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const PerishabilitySchema = z.enum(['shelf_stable', 'perishable']);
export const FoodStateSchema = z.enum(FOOD_STATES);
export const FoodCategorySchema = z.enum(FOOD_CATEGORIES);
export const LineKindSchema = z.enum(['item', 'coupon', 'return', 'non_food']);

export const PackageSchema = z.object({
  count: z.number().positive().optional().describe('Number of sub-packages, e.g. 2 for "2X32 OZ"'),
  size: z.number().positive().optional().describe('Amount per sub-package, e.g. 32'),
  unit: z.string().min(1).optional().describe('One of oz, fl_oz, lb, g, kg, ml, l, gal, qt, pt, ct'),
});

// --- canonicalizeItems ---

export const CanonicalizeCandidateSchema = z.object({
  food_id: z.string().min(1),
  name: z.string(),
  aliases: z.array(z.string()).default([]),
  category: z.string(),
  perishability: PerishabilitySchema,
});

export const CanonicalizeInputSchema = z.object({
  lines: z
    .array(
      z.object({
        line_id: z.string().min(1),
        raw_text: z.string(),
        quantity: z.number().optional(),
        price_cents: z.number().int().optional(),
        line_kind: LineKindSchema.optional(),
        hint: z
          .object({
            food_name: z.string().optional(),
            // The server sends {count?, size?, unit?}; a printed string ("2X32 OZ") is also accepted.
            // Values are hints only: unusable numbers are dropped, never rejected.
            package: z
              .union([
                z.string(),
                z.object({ count: z.number().optional(), size: z.number().optional(), unit: z.string().optional() }),
              ])
              .optional(),
            location_guess: z.string().optional(),
          })
          .optional(),
      }),
    )
    .min(1),
  candidates: z.record(z.string(), z.array(CanonicalizeCandidateSchema)).default({}),
});

export const CanonicalizeOutputSchema = z.object({
  lines: z.array(
    z.object({
      line_id: z.string(),
      canonical_name: z.string().min(1),
      category: FoodCategorySchema,
      perishability: PerishabilitySchema,
      package: PackageSchema.optional(),
      line_kind: LineKindSchema,
      match: z.object({
        food_id: z.string().min(1).describe('A candidate food_id for this line, or "new"'),
        confidence: ConfidenceSchema,
      }),
      rationale: z.string(),
    }),
  ),
});

// --- estimateShelfLife ---

export const ShelfLifeInputSchema = z.object({
  food_name: z.string().min(1),
  category: z.string().optional(),
  perishability: PerishabilitySchema.optional(),
  // Deduped (first occurrence wins): the per-call model schema lists each state once as required.
  states: z
    .array(FoodStateSchema)
    .min(1)
    .transform((states) => [...new Set(states)]),
  location: z.string().optional(),
  anchor_date: z.string().optional(),
});

export const ShelfLifeEstimateSchema = z.object({
  days: z.number().int().nonnegative().nullable().describe('null = no meaningful expiry'),
  confidence: ConfidenceSchema,
});

export const ShelfLifeOutputSchema = z.object({
  // Explicit optional keys rather than a record: guided decoders handle `properties` better
  // than `propertyNames`.
  per_state: z.object({
    sealed: ShelfLifeEstimateSchema.optional(),
    opened: ShelfLifeEstimateSchema.optional(),
    frozen: ShelfLifeEstimateSchema.optional(),
    thawed: ShelfLifeEstimateSchema.optional(),
    prepared: ShelfLifeEstimateSchema.optional(),
  }),
  rationale: z.string(),
});

// --- parseActivity ---

export const ActivityKindSchema = z.enum([
  'bought', 'cooked', 'used', 'finished', 'discarded', 'froze', 'thawed', 'opened', 'moved',
]);

export const ActivityQuantitySchema = z.object({
  kind: z.enum(['exact', 'approx', 'unknown']),
  amount: z.number().nonnegative().optional(),
  unit: z.string().optional(),
  fraction: z.number().min(0).max(1).optional().describe('Share of the lot, e.g. 0.5 for "half"'),
});

export const ParseActivityInputSchema = z.object({
  text: z.string().min(1),
  now: z.string(),
  context: z.object({
    lots: z
      .array(
        z.object({
          lot_id: z.string().min(1),
          food_name: z.string(),
          location: z.string(),
          state: FoodStateSchema,
          quantity_text: z.string(),
        }),
      )
      .default([]),
    locations: z.array(z.string()).default([]),
    recipes: z.array(z.object({ recipe_id: z.string().min(1), title: z.string() })).default([]),
  }),
});

export const ParseActivityOutputSchema = z.object({
  activities: z.array(
    z.object({
      kind: ActivityKindSchema,
      items: z.array(
        z.object({
          lot_id: z.string().optional(),
          food_name: z.string().optional(),
          quantity: ActivityQuantitySchema.optional(),
          to_location: z.string().optional(),
        }),
      ),
      recipe_id: z.string().optional(),
      servings: z.number().positive().optional(),
    }),
  ),
  ambiguities: z.array(
    z.object({
      text: z.string(),
      reason: z.string(),
      candidate_lot_ids: z.array(z.string()),
    }),
  ),
  confidence: ConfidenceSchema,
});

// --- rankRecipes ---

export const UseSoonLotSchema = z.object({
  lot_id: z.string().min(1),
  food_name: z.string(),
  expires_on: z.string(),
  urgency: z.enum(['expired', 'urgent', 'soon']),
});

export const RankRecipesInputSchema = z.object({
  candidates: z.array(
    z.object({
      recipe_id: z.string().min(1),
      title: z.string(),
      score: z.number(),
      coverage_summary: z.string(),
      expiring_lots_used: z.array(UseSoonLotSchema).default([]),
    }),
  ),
  use_soon: z.array(UseSoonLotSchema).default([]),
  constraints: z
    .object({
      max_total_min: z.number().positive().optional(),
      effort: z.string().optional(),
      diet_tags: z.array(z.string()).optional(),
    })
    .default({}),
  include_ideas: z.boolean(),
});

export const RankRecipesOutputSchema = z.object({
  ranked: z.array(z.object({ recipe_id: z.string(), explanation: z.string() })),
  ideas: z.array(
    z.object({
      title: z.string().min(1),
      uses: z.array(z.string()),
      why: z.string(),
      est_total_min: z.number().positive().optional(),
    }),
  ),
});

// --- types ---

export type Confidence = z.infer<typeof ConfidenceSchema>;
export type CanonicalizeInput = z.input<typeof CanonicalizeInputSchema>;
export type CanonicalizeOutput = z.output<typeof CanonicalizeOutputSchema>;
export type ShelfLifeInput = z.input<typeof ShelfLifeInputSchema>;
export type ShelfLifeOutput = z.output<typeof ShelfLifeOutputSchema>;
export type ParseActivityInput = z.input<typeof ParseActivityInputSchema>;
export type ParseActivityOutput = z.output<typeof ParseActivityOutputSchema>;
export type RankRecipesInput = z.input<typeof RankRecipesInputSchema>;
export type RankRecipesOutput = z.output<typeof RankRecipesOutputSchema>;

export const FUNCTION_SCHEMAS = {
  canonicalizeItems: { input: CanonicalizeInputSchema, output: CanonicalizeOutputSchema },
  estimateShelfLife: { input: ShelfLifeInputSchema, output: ShelfLifeOutputSchema },
  parseActivity: { input: ParseActivityInputSchema, output: ParseActivityOutputSchema },
  rankRecipes: { input: RankRecipesInputSchema, output: RankRecipesOutputSchema },
} as const;
