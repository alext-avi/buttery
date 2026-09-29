# DuploCloud for local Buttery development

For the architecture, MCP connection, verified QA flow, and deployment boundaries, see [DuploCloud integration](duplocloud.md). This runbook covers operating the local installation.

Use the DuploCloud DevKit's Claude Code subscription provider for the local QA agent. Ticket work consumes the developer's Claude Code subscription limits. Buttery's application runtime and MCP server remain separate from this operations environment.

## Prepared on this Mac

- Official source: https://github.com/duplocloud/devkit
- Installed at `.local/duplocloud-devkit`, from commit `e9f016fd90a67611907fcf673701351669eaa47d`.
- Docker project: `buttery-duplo`.
- Subscription mode selected in the DevKit's private `.env`.
- Claude's official `setup-token` authorization completed, and its token is stored privately in that file. The transient CLI output was removed.
- The existing trial license was recovered and activated. All six long-running services are running; the seventh container performed one-time volume initialization.
- A real inference call from the agent container using the subscription returned `BUTTERY_LOCAL_OK` successfully.
- The default `extension-dev` workspace, local agent, and subscription model registrations are ready.
- `buttery-qa` is created (workspace ID `6abc1be3164628264b4cf83e`). The existing local Claude agent is attached. The admin account has verified access through `buttery-qa-access` and `buttery-qa-group`.
- The Studio API reports `Healthy`. Scope `buttery-demo-qa` connects the workspace to the local Buttery MCP server using a dedicated synthetic household credential.
- Ticket `butteryqa-1` passed identity, receipt import/apply, inventory/package verification, duplicate detection, and undo on 2026-09-29. See [the readiness report](demo-readiness.md).
- Local override health checks use the actual container ports (Studio 60021, UI 80); both services report healthy.
- All published ports bind to `127.0.0.1` through `compose.override.yaml`.
- The entire `.local` directory is ignored by Buttery's Git repository. The DevKit `.env` is readable only by its owner.

| Service | Local address after startup |
| --- | --- |
| AI Studio UI | http://localhost:4210 |
| AI Studio API | http://localhost:60031 |
| Agent | http://localhost:8010 |
| Browser terminal | http://localhost:6061 |
| Qdrant | http://localhost:6333 |
| MongoDB | localhost:27018 |

## Start and sign in on this Mac

The stack is running. To start it again after stopping it, use:

```sh
bash scripts/duplo-local.sh start
```

The local admin email and a generated password are already stored as `Authentication__LocalAdminEmail` and `Authentication__LocalAdminPassword` in `.local/duplocloud-devkit/.env`. Open that file privately when you need to sign in; do not print or paste its contents into chat. This password is for the local AI Studio instance.

## Authentication on a fresh installation

In your own terminal, run:

```sh
claude setup-token
```

Complete the browser authorization. Claude displays a long-lived token. Keep it in the terminal until the next command asks for it; do not paste it into chat or a command-line argument.

From the Buttery project directory, run:

```sh
bash scripts/duplo-local.sh start
```

The official DevKit prompts for your DuploCloud account email, recovers the existing license by an email confirmation link if needed, asks you to choose a local admin password, and accepts the Claude token through a hidden prompt. Use the same account email used for the verified DuploCloud trial. The password is for this local AI Studio login.

After startup, open http://localhost:4210 and sign in using those local admin credentials. The official bootstrap creates the `extension-dev` workspace, registers the local agent, and offers the subscription models. No Buttery QA ticket has been executed until the ticket has an actual result in AI Studio.

For daily use:

```sh
bash scripts/duplo-local.sh status
bash scripts/duplo-local.sh stop
bash scripts/duplo-local.sh start
```

Stopping preserves data. Credentials and volumes also survive ordinary restarts. Do not use the vendor's reset/wipe options for routine shutdown.

## First QA workflow

Select the `buttery-qa` workspace after signing in. If it is missing from an existing session, sign out and back in so the workspace permissions refresh.

Select the attached `buttery-demo-qa` scope. Its `buttery-local-demo` MCP server targets `http://host.docker.internal:8790/mcp`; its credential belongs only to synthetic household `fd91e150-7d87-449e-b423-ccbc4ba30060`. The credential is stored as a sensitive field in DuploCloud. This scope does not grant deployment or shell access to the Buttery repository.

For a container connecting to an app running on this Mac, use `host.docker.internal` with Buttery's configured port. The loopback address inside the agent container refers to the container itself. Use a dedicated test household and its own Buttery token. The DevKit currently has no mount of the Buttery repository and no access to its application `.env`.

Initial ticket text:

> Verify the local Buttery build against a dedicated test household. Record the app version, target URL, time, and identity returned by `whoami`. Check `/healthz` and MCP tool discovery. Import a receipt fixture, inspect the proposal, accept its supported inventory changes, then submit the same receipt again and prove that inventory did not increase a second time. Apply one correction through the review flow and verify that MCP reads and the inventory/review pages show the same state. Report each check as PASS, FAIL, or BLOCKED with evidence. Use synthetic fixtures only. Do not modify application code, deploy infrastructure, or use a personal household. If a required tool or screen is unavailable, record the gap instead of claiming a pass.

The fixtures live in `tests/fixtures/food-images`. Start with `receipt-warehouse-clean.png` and its recapture counterpart. Their manifest describes the expected duplicate relationship. Receipt ingestion in the current implementation accepts structured extraction from the primary agent; submit that data using the published MCP schema.

The messy fridge fixtures are retained for a later reconciliation check: an incomplete fridge observation must preserve unseen items. As of this setup, `submit_observation` supports receipts only, so that scenario must be reported as BLOCKED until fridge observations are implemented.

Before allowing an agent to run the repository's automated tests, provide an isolated test database. The server tests truncate tables in the database named by `TEST_DATABASE_URL`; the default is `buttery_test` on port 5433. A QA run must never point this variable at the application's ordinary development database.

## Running another check

Sign in to the UI using the privately saved local admin credentials, select `buttery-qa`, and open `butteryqa-1` or create a new ticket with the same synthetic scope. Keep the identity check at the start and review each requested mutation. Undo intentionally reopens the receipt proposal; the successful run left no active inventory but retained the audit trail and pending review.

For a REST integration with this installed DevKit version:

- The Claude agent requires `sendMessageStreaming`; plain `sendMessage` returns HTTP 400.
- The agent expects the signed-in session in `platform_context.duplo_token` and the internal callback base URL in `platform_context.duplo_base_url`. A bare admin bearer request discovered tools but did not supply an approval callback credential. Keep these values private; do not embed them in the prompt or a tracked script.
- Read `agentCallback/pending`, inspect the exact call, and submit its decision to `agentCallback/respond` as the data object containing `tool_calls`, matching the tool-use ID. A full message envelope is the wrong live-callback response shape.
- After the callback times out, resume with a decision-only user message: empty content plus the exact approved call in `data.tool_calls`. Inspect ticket status first so a continuation does not race an active turn.
- No global auto-approval policy was enabled for this QA run.

## Deploying the demo

The separate Vultr demo uses [GitHub Actions deployment on main](runbooks/deploy-vultr.md). DuploCloud can run a follow-up QA ticket against that demo after a dedicated demo-household scope is connected. The current local QA scope cannot promote releases; GitHub Actions owns deployment credentials and runs the versioned promotion scripts.

The optional Terraform extension source could not be downloaded by the vendor bootstrap. Qdrant is running and registered, but its document collection was skipped because no embedding model was registered. Neither feature is required for the initial Buttery QA workflow.
