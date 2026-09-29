# Connecting agents to Buttery

Base URL: the Tailscale Funnel URL in `.env` (`PUBLIC_BASE_URL`). MCP endpoint: `<base>/mcp`.

## Claude (web, desktop, iOS/Android)
Settings → Connectors → Add custom connector → URL `<base>/mcp` → sign in with AuthKit using the same email as your token user (identities link by email). The connector is then available in the mobile app.

## Claude Code
claude mcp add --transport http buttery <base>/mcp --header "Authorization: Bearer <btr_ token>"

## Codex CLI
In ~/.codex/config.toml (check `codex mcp --help` for your version's keys):
[mcp_servers.buttery]
url = "<base>/mcp"
bearer_token_env_var = "BUTTERY_TOKEN"

## agentdock workers (codex-isolated, claude-code-2, …)
Add an HTTP MCP server for the worker through agentdock's MCP management:
URL `http://buttery:8790/mcp` (container alias on the agent-container_default network), header `Authorization: Bearer <btr_ token>`. Config activates on the worker's next task.

## Tokens
Create: `docker compose exec app npm run token:create -- --email you@example.com --client "<client name>"`. One token per client, so history shows which client made each change.
