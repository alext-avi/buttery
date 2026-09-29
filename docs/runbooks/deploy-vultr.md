# Automatic Vultr demo deployment

The GitHub Actions workflow `.github/workflows/demo.yml` checks pull requests to `main`. A push to `main` (including a merged PR) runs the checks and automatically promotes the passing release to the Vultr demo. Manual dispatch is allowed only from `main`. GitHub Actions performs deployment; DuploCloud remains the separate QA/operations surface.

## Infrastructure handoff

Provision one **Linux AMD64** Vultr VM with Docker Engine, the Docker Compose plugin (`docker compose up --wait` support), Bash, Python 3, `tar`, and `flock`. No GPU or Node installation is needed on the host.

Create a deployment user (recommended `buttery`) with Docker access and ownership of `/opt/buttery`. Install its CI SSH public key. Docker access is effectively host-level access; use a key dedicated to this demo host. Allow that user's SSH access from the chosen GitHub runner network. For ordinary GitHub-hosted runners, do not assume there is one fixed source IP.

The host should have:

- `/opt/buttery/`, writable by the deployment user.
- `/opt/buttery/.env.demo`, mode `600`, populated from `deploy/demo/.env.example` with separate random secrets. The deployment user must be able to read it.
- An HTTPS reverse proxy on the chosen demo domain, forwarding to **127.0.0.1:8793**. It must preserve the host/protocol and support streaming HTTP at `/mcp` without buffering or a short response timeout.
- Inbound HTTPS and the agreed SSH route; no published database port.
- Outbound access to GHCR and its image layers, Docker Hub for PostgreSQL, and configured runtime providers.

Set `DEMO_PUBLIC_BASE_URL` in the host env file to the exact HTTPS origin. Use a persistent disk for Docker's `buttery-demo_pgdata` volume. Backups created by deployments live under `/opt/buttery/.local/demo-releases/backups`; off-host backup retention remains an infrastructure responsibility.

**Do not copy the developer `.env`, `.local`, Claude subscription credential, or a local database to this VM.** The demo has its own database and runtime credentials. Configure AuthKit against the demo callback URL if account sign-in is desired; otherwise token sign-in works for a provisioned demo user. With `SIGNUP_MODE=closed`, provision/invite the presenter before the demo. The Claude Code subscription powers the local DuploCloud agent; it is not a server runtime credential.

## GitHub configuration

In `alext-avi/buttery`, create an environment named **`demo`**, allow deployments from **`main`**, and leave required reviewers off for automatic deployment.

| Kind | Name | Value |
| --- | --- | --- |
| Environment variable | `DEPLOY_HOST` | VM IPv4 address or SSH hostname |
| Environment variable | `DEPLOY_USER` | Deployment user, e.g. `buttery` |
| Environment variable | `DEMO_URL` | HTTPS origin, e.g. `https://demo.example.com` |
| Optional variable | `DEPLOY_PORT` | Default `22` |
| Optional variable | `DEPLOY_DIR` | Default `/opt/buttery` |
| Optional variable | `DEPLOY_ENV_FILE` | Default `/opt/buttery/.env.demo` |
| Environment secret | `DEPLOY_SSH_KEY` | Private key matching the host's CI public key |
| Environment secret | `DEPLOY_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for this host/port |

Obtain and verify the SSH host key through the Vultr console or the infrastructure provisioning output. Do not accept a key discovered opportunistically during the deployment. Keep private keys and application secrets out of chat and repository files.

GHCR authentication uses the workflow's short-lived `GITHUB_TOKEN`. No long-lived registry PAT is required. The repository must have Actions and package publishing enabled. If an existing GHCR package has separate access settings, grant this repository access. Images remain subject to the package's visibility settings; the workflow does not make them public.

These commands set nonsecret values when the host is available:

```sh
gh variable set DEPLOY_HOST --env demo --body '<host>'
gh variable set DEPLOY_USER --env demo --body 'buttery'
gh variable set DEMO_URL --env demo --body 'https://<demo-domain>'
gh secret set DEPLOY_SSH_KEY --env demo < /private/path/to/deploy-key
gh secret set DEPLOY_KNOWN_HOSTS --env demo < /private/path/to/verified-known-hosts
```

## What each deployment does

1. Installs locked dependencies, typechecks, runs workspace tests against an ephemeral PostgreSQL database, and builds the UI.
2. Builds an AMD64 image tagged with the commit SHA. Checks that local credentials/config and Git history are absent and the built UI exists.
3. Boots that exact image with a disposable demo database. Checks migrations/startup, `/healthz`, the UI and its assets, and the unauthenticated MCP rejection.
4. Publishes the tested image to GHCR and resolves its immutable digest.
5. Copies only deployment scripts and Compose configuration to Vultr over verified SSH. Pulls the digest using temporary registry credentials, then removes that registry config.
6. Serializes promotion, backs up an existing demo database before migrations, starts the selected image, waits for health, and verifies its running image ID.
7. Checks the public HTTPS health endpoint, UI assets, and MCP authentication boundary. Records the digest in the Actions run summary and the host's release record.

A failed check fails the workflow. Failed builds never reach the VM. Main-branch runs are serialized, never cancelled mid-migration; queued updates can coalesce to the newest commit. The host also has a deployment lock. Public smoke checks are read-only; a passing deployment is not a claim that vision extraction, login, or the full authenticated receipt demo was re-evaluated remotely.

## Local rehearsal or manual promotion

Create a private env file from `deploy/demo/.env.example`. Build for the actual Docker host architecture, then:

```sh
docker build -t buttery-demo:<version> .
bash scripts/check-release-image.sh buttery-demo:<version>
bash scripts/promote-demo.sh buttery-demo:<version> /absolute/path/to/.env.demo
node scripts/smoke-demo.mjs http://localhost:8793
```

This uses project `buttery-demo` and a separate database volume. Ordinary development remains on port 8790. The script rejects an image built for a different CPU architecture, unversioned/`latest` images, and invalid secret configuration. It resolves a versioned tag to its immutable local image ID before starting the app. On Vultr, CI builds AMD64 and passes a registry digest.

## Failure and rollback

Release records contain the candidate image ID, previous running image ID/reference, and pre-migration database backup path. `latest.json` describes the last locally healthy promotion; the Actions result additionally gates the public HTTPS smoke check. A failure after promotion does not automatically undo schema changes.

For an application-only rollback, first verify that the previous image supports the current schema, then run `promote-demo.sh` with that known image ID/reference and the same private env file. If a schema restore is required, stop writes and explicitly restore the matching backup as a separate recovery action. Restoring a backup can discard writes made after the snapshot; this workflow never restores a database automatically. Keep previous images/backups until the new release has been demonstrated successfully.

GitHub reference: [publishing Docker images with GITHUB_TOKEN](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [pulling container images by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
