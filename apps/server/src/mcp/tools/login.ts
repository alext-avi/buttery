import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppDeps } from '../../http/app';
import type { Principal } from '../../identity/principal';
import { mintLoginCode } from '../../identity/loginCodes';
import { withErrors } from '../respond';

export function registerLoginTools(server: McpServer, deps: AppDeps, p: Principal) {
  server.registerTool(
    'get_login_code',
    {
      title: 'Get a sign-in code',
      description:
        'Mint a short-lived code that signs the user in to the Buttery web app. Append login=<code> to every Buttery link you give the user (so tapping it signs them in), or give them the code to type at login_url on another device. Codes last a few minutes and work up to 3 times; mint a new one for each message with links.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    withErrors(async () => {
      const { code, expiresAt, usesLeft } = await mintLoginCode(deps.db, deps.config, p);
      const base = deps.config.PUBLIC_BASE_URL;
      const minutes = deps.config.LOGIN_CODE_TTL_MINUTES;
      return {
        code,
        expires_at: expiresAt.toISOString(),
        uses_left: usesLeft,
        append: `login=${code}`,
        example: `${base}/inventory?login=${code}`,
        login_url: `${base}/login`,
        how_to_use: `Append login=${code} to every Buttery link you give the user in this message (use & if the link already has a ?). For another device, give them the code and ${base}/login. Mint a new code for each message with links; this one expires in ${minutes} minutes.`,
      };
    }),
  );
}
