import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(8790),
  PUBLIC_BASE_URL: z.url().default('http://localhost:8790'),
  SESSION_SECRET: z.string().min(32),
  WEB_DIST_DIR: z.string().optional(),
  SIGNUP_MODE: z.enum(['open', 'closed']).default('open'),
  LOGIN_CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  /** Behind a reverse proxy (Caddy on the Vultr demo), read the client IP from X-Forwarded-For for rate limiting. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  AUTHKIT_DOMAIN: z.url().optional(),
  AUTHKIT_ISSUER: z.url().optional(),
  AUTHKIT_AUDIENCE: z.string().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const config = EnvSchema.parse(present);
  return { ...config, PUBLIC_BASE_URL: config.PUBLIC_BASE_URL.replace(/\/$/, '') };
}
