import type { Principal } from '../identity/principal';

export type BearerResolver = (token: string) => Promise<Principal | null>;

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}
