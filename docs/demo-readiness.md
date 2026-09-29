# Buttery demo readiness — 2026-09-29

The receipt workflow is ready for a focused local demo. The Vultr deployment workflow is live: every merge to `main` deploys to `https://140-82-48-162.sslip.io`.

## Verified

| Check | Result | Evidence / boundary |
| --- | --- | --- |
| Workspace tests | PASS | Final run: 217 passed, 2 optional reasoning tests skipped; dedicated `buttery_readiness_test` database |
| Typechecks and web build | PASS | All workspaces typechecked; production UI built into the tested container |
| Mobile review | PASS | 393×852 browser check: deep-link login return, receipt editing, skip, apply, inventory, provenance; no horizontal overflow |
| Package preservation | PASS | Changing yogurt location keeps `2 × 32 oz` before and after apply; fixed `OpCard` to send quantity edits only when quantity changes |
| Fresh MCP client | PASS | Independent client recovered five applied lots, freezer yogurt, and the skipped strawberry line absent |
| Duplicate + UI undo | PASS | Same structured receipt did not add inventory; UI-origin undo restored 5→0 |
| Live DuploCloud agent | PASS | `butteryqa-1`: identity, import, apply six, verify package, duplicate, undo 0→6→6→0 |
| Release hygiene | PASS | `.local`, `.env`, `.mcp.json`, `.claude`, `.codex`, and `.git` absent from the clean container; built UI present |
| Local deployment rehearsal | PASS | Separate `buttery-demo` project on port 8793; migration/startup/health/UI/assets/MCP auth boundary |
| Repeat promotion + backup | PASS | Reused tested image, wrote a readable `pg_dump` archive before promotion, stayed healthy |
| Workflow validation | PASS | actionlint 1.7.12; Bash syntax; JavaScript syntax; Git whitespace checks |
| Remote Vultr deployment | PASS | Merges to `main` deploy automatically to `https://140-82-48-162.sslip.io`: GHCR digest promotion with a pre-migration backup, public HTTPS smoke checks, and an authenticated receipt import on Crusoe. See the [runbook](runbooks/deploy-vultr.md#first-automatic-deployments-2026-09-29). |

The existing Playwright E2E file gained regression assertions for package preservation. That suite was not executed in this session; the corresponding flow was verified through the browser. The fresh-client and mobile tests used fixture transcription and deterministic test reasoning. The live DuploCloud run used the actual local app: canonicalization reported cache, shelf-life calls reported model results, and `fallback_used` was false. None of these checks measures image/OCR accuracy.

## Live agent evidence

- Workspace: `buttery-qa` (`6abc1be3164628264b4cf83e`)
- Ticket: `butteryqa-1` (`6abc2249c91c963878a15e83`)
- Synthetic household: `fd91e150-7d87-449e-b423-ccbc4ba30060`
- Observation: `3993ed3f-272a-4cef-9b0f-24c87319e71d`
- Proposal: `90d416dd-0367-406e-9ab9-1209283e30d6`
- Applied change set: `b79f78e1-2b90-4673-a839-107839b34b4d`
- Undo change set: `e483c40a-8972-4fb3-b129-d1e371beb5b1`
- Final active inventory: **0**. Undo retained history and reopened six proposal lines, as designed.

The successful run kept per-call approvals enabled. API callback wiring issues were repaired before continuing; failed/expired approvals did not execute their tools. Detailed local logs and results are under `.local/demo-readiness` and are intentionally excluded from Git and release images. Some files there hold credentials; do not upload that directory as CI artifacts or copy it to the demo host.

## Five-minute demo

1. Start with the primary agent and ask it to recover the current household state through MCP.
2. Show a receipt image and ask the primary agent to extract the visible lines, preserve package sizes, flag uncertainty, and submit a receipt observation. This live image step still needs a presenter rehearsal with the chosen Claude/Codex client.
3. Open the returned review link on a phone-sized view. Point out the verdict at the top ("Looks right", "Mostly confident" or "Needs a review"): it comes from Crusoe's per-line confidence plus Buttery's own checks, and on `safe_to_apply` the agent would simply have asked for a yes in chat. Correct one location, skip an item, and apply.
4. Start a fresh agent conversation. Ask what is on hand, where it is, and which dates are printed versus estimated.
5. Submit the receipt again. Show that inventory does not grow.
6. Undo the receipt import. Show the inventory and retained history agree.

For a deterministic fallback during rehearsal, use the structured warehouse fixture from `tests/fixtures/food-images/sources/expected-text.json`, clearly described as supplied transcription. After undo, reopen the existing receipt review to repeat the same demo instead of deleting audit records.

## Scope and release status

This implementation supports receipt observations. Fridge reconciliation, recipe planning, and shopping-list workflows are future scope; do not present those as implemented MCP flows. Messy fridge imagery remains useful for later evaluation.

A legacy local image included development configuration because `.local` was not excluded. The Docker ignore rules and release-image check now prevent that packaging mistake. Publish only a newly built image that passes the check; the old local image is not a release candidate.

The clean local rehearsal image is `buttery-demo:ci-rehearsal-20260929`, ARM64 image ID `sha256:49fa6c0b5552db39733cf03ad3d9efa73fe16b941a40899afa38d13d90c75c09`. It demonstrates the promotion scripts on this Mac. CI builds a separate Linux AMD64 image for Vultr, rehearses that exact image, and deploys its registry digest. No image has been pushed or deployed remotely by this readiness work.

The GitHub `demo` environment exists with a `main`-only branch policy and no required reviewer gate. See [the Vultr handoff and deployment runbook](runbooks/deploy-vultr.md) for variables, secrets, host paths, release checks, and rollback.
