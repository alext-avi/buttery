import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { foods } from '../src/db/schema';
import { undoChangeSet } from '../src/services/changes';
import { upsertFood, UpsertFoodInputSchema } from '../src/services/foods';
import { resetDb, testDb } from './helpers/db';
import { seedUser, testDeps } from './helpers/app';

const db = testDb();

describe('upsertFood', () => {
  beforeEach(() => resetDb());

  it('creates a food with user-provided shelf life and aliases', async () => {
    const { principal } = await seedUser(db);
    const r = await upsertFood(testDeps(), principal, UpsertFoodInputSchema.parse({ name: 'Oat milk', perishability: 'shelf_stable', shelf_life_days: { opened: 7 }, aliases: ['OATLY 64OZ'], idempotency_key: 'food-0001' }));
    expect(r.created).toBe(true);
    expect(r.food).toMatchObject({ aliases: ['oatly 64oz'], shelf_life: { opened: { days: 7, source: 'user', confidence: 'high' } } });
  });

  it('updates an existing food by name and can be undone', async () => {
    const { principal } = await seedUser(db);
    const deps = testDeps();
    await upsertFood(deps, principal, UpsertFoodInputSchema.parse({ name: 'Oat milk', perishability: 'shelf_stable', idempotency_key: 'food-0002' }));
    const upd = await upsertFood(deps, principal, UpsertFoodInputSchema.parse({ name: 'oat milk', is_staple: true, default_location: 'pantry', idempotency_key: 'food-0003' }));
    expect(upd).toMatchObject({ created: false, food: { is_staple: true, default_location: 'pantry' } });
    await undoChangeSet(db, principal, { change_set_id: upd.change_set_id, idempotency_key: 'undo-food-1' });
    const [f] = await db.select().from(foods).where(eq(foods.normalizedName, 'oat milk'));
    expect(f).toMatchObject({ isStaple: false, defaultLocation: null });
  });
});
