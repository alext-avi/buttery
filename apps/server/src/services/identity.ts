import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { households, users } from '../db/schema';
import type { Principal } from '../identity/principal';
import { notFound } from '../errors';

export async function getHousehold(db: Db, householdId: string) {
  const [h] = await db.select().from(households).where(eq(households.id, householdId));
  if (!h) throw notFound('Household');
  return h;
}

export async function getWhoami(db: Db, p: Principal, config: Config) {
  const household = await getHousehold(db, p.householdId);
  const [user] = await db.select().from(users).where(eq(users.id, p.userId));
  return {
    user: { id: p.userId, email: user?.email ?? null, display_name: user?.displayName ?? null },
    household: { id: household.id, name: household.name, timezone: household.timezone },
    connection: { id: p.connectionId, client_name: p.clientName },
    links: { inventory: `${config.PUBLIC_BASE_URL}/inventory` },
    sign_in: 'Links need a login code to sign the user in: call get_login_code and append login=<code> to each Buttery link.',
  };
}
