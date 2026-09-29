import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().default(8790),
  PUBLIC_BASE_URL: z.url().default('http://localhost:8790'),
  SESSION_SECRET: z.string().min(32),
  WEB_DIST_DIR: z.string().optional(),
  AUTHKIT_DOMAIN: z.url().optional(),
  AUTHKIT_ISSUER: z.url().optional(),
  WORKOS_CLIENT_ID: z.string().optional(),
  WORKOS_API_KEY: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const config = EnvSchema.parse(present);
  return { ...config, PUBLIC_BASE_URL: config.PUBLIC_BASE_URL.replace(/\/$/, '') };
}
