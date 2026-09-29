// Public contract of @buttery/reasoning. The server integrates against these exports.

export {
  createReasoningProvider,
  createFakeProvider,
  createFallbackProvider,
  configFromEnv,
  DEFAULT_CRUSOE_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MODELS,
  type FakeScript,
} from './provider.ts';
export { SHELF_LIFE_DEFAULTS, FOOD_CATEGORIES, FOOD_STATES, categoryDefaults } from './shelfLifeDefaults.ts';
export type { FoodCategory, FoodState, CategoryDefaults, ShelfLifeBound, Perishability } from './shelfLifeDefaults.ts';
export { createMemoryCache } from './cache.ts';
export { ReasoningInputError, DEFAULT_TIMEOUTS_MS } from './engine.ts';
export * from './schemas.ts';
export type {
  ReasoningProvider,
  ReasoningFunction,
  CallContext,
  ReasoningCache,
  ReasoningResult,
  ReasoningCallRecord,
  ReasoningConfig,
} from './types.ts';
