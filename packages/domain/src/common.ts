import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const PerishabilitySchema = z.enum(['shelf_stable', 'perishable']);
export type Perishability = z.infer<typeof PerishabilitySchema>;

export const LOT_STATES = ['sealed', 'opened', 'frozen', 'thawed', 'prepared'] as const;
export const LotStateSchema = z.enum(LOT_STATES);
export type LotState = z.infer<typeof LotStateSchema>;

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .describe('Unique key for this user action. Generate a new one per action; reuse it only when retrying the same call.');

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
export type IsoDate = string;
