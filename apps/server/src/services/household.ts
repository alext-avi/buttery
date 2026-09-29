import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { households } from '../db/schema';
import { AppError } from '../errors';
import type { Principal } from '../identity/principal';

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const UpdateHouseholdSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  timezone: z.string().max(64).refine(isTimeZone, 'Unknown timezone').optional(),
});

export async function updateHousehold(db: Db, p: Principal, input: z.infer<typeof UpdateHouseholdSchema>) {
  if (!input.name && !input.timezone) throw new AppError('invalid_input', 'Nothing to update', 422);
  await db
    .update(households)
    .set({ ...(input.name ? { name: input.name } : {}), ...(input.timezone ? { timezone: input.timezone } : {}) })
    .where(eq(households.id, p.householdId));
}
