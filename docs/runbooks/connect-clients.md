# Connecting agents to Buttery

| | Demo (Vultr) | Local development |
|---|---|---|
| Base URL | `https://140-82-48-162.sslip.io` | `http://localhost:8790` (`PUBLIC_BASE_URL`) |
| MCP endpoint | `<base>/mcp` | `<base>/mcp` |
| Tokens | `<base>/settings`, or on the host (below) | `<base>/settings`, or `npm run token:create` |

## Claude (web, desktop, iOS/Android)
Settings → Connectors → Add custom connector → URL `<base>/mcp` → Connect → sign in with WorkOS
AuthKit. If you already have a token user, use the same email: identities are linked by email. The
connector is then available in the Claude mobile app, so you can share a receipt photo straight
from your phone.

## Claude Code
```sh
claude mcp add --transport http buttery <base>/mcp --header "Authorization: Bearer <btr_ token>"
```

## Codex CLI
In `~/.codex/config.toml` (check `codex mcp --help` for your version's keys):
```toml
[mcp_servers.buttery]
url = "<base>/mcp"
bearer_token_env_var = "BUTTERY_TOKEN"
```

## agentdock workers (codex-isolated, claude-code-2, …)
Add an HTTP MCP server for the worker through agentdock's MCP management, with the header
`Authorization: Bearer <btr_ token>`:
- against the demo: `https://140-82-48-162.sslip.io/mcp`
- against a local `docker compose` stack: `http://buttery:8790/mcp` (the container's alias on the
  `agent-container_default` network)

The config takes effect on the worker's next task.

## Tokens
- **Demo:** sign in at `<base>/settings` and create one per agent, or create one on the host:
  ```sh
  ssh root@140.82.48.162 'docker exec buttery-demo-app-1 npm run -s token:create -- --email you@example.com --client "Claude Code"'
  ```
- **Local:** `npm run token:create -- --email you@example.com --client "Claude Code"`.

Use one token per client, so history shows which client made each change. Revoke tokens at
`<base>/settings`.

## What to try first
1. Ask the agent: "What's in my Buttery household?" It calls `get_household_summary`.
2. Share a receipt photo and say "I bought these". The agent submits the transcription and follows
   the returned verdict. For `safe_to_apply` it asks you for a quick yes; otherwise it reads back
   the lines worth a glance, or sends a review link.
3. Start a fresh conversation and ask "What's expiring this week?"
