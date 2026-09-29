import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { mintPageLink } from '../../identity/loginCodes';
import { withErrors } from '../respond';

export function registerLoginTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'get_login_code',
    {
      title: 'Get a one-tap page link',
      description:
        'Turn a Buttery page URL (a review_url, an item link or the inventory link) into a link the user can open without signing in. The returned url carries a one-time code and opens only that page: it does not sign the user in, and other pages still ask them to sign in. Call it once per link you share; the code expires if not opened within a few minutes.',
      inputSchema: { url: z.string().min(1).max(500).describe('The Buttery page URL to share, e.g. a review_url from submit_observation') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withErrors(async ({ url }: { url: string }) => {
      const link = await mintPageLink(deps.db, deps.config, p, url);
      return {
        url: link.url,
        expires_at: link.expiresAt.toISOString(),
        opens: 'once',
        how_to_use: `Give the user this url instead of the plain link. It opens that one page once, without signing in, and must be opened within ${deps.config.LOGIN_CODE_TTL_MINUTES} minutes. Call get_login_code again for each other link.`,
      };
    }),
  );
}
