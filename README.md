# Sherlock

Sherlock is a document Data Room for company preparation and review. It includes company workspaces, document previews and versions, scoped guest access, and an MCP interface for a user's own agent.

The [official Sherlock service](https://sherlock.capital) and independently configured installations use this application. This repository does not include customer documents, accounts, credentials, private research wikis, or a connection to the official service.

## Status

This is the initial clean source distribution. Local development uses Convex's local backend. Production uses your own Convex and WorkOS configuration. SQLite or another authentication provider is not currently a drop-in replacement for those integrations.

The software does not include financial advisory services or private research material.

## Requirements

- Node.js 24.22.1 and Bun 1.4.2 (also pinned in the repository).
- A supported macOS or Linux environment for the local Convex backend.
- For a hosted installation: your own Convex deployment and WorkOS AuthKit project.

## Local development

```sh
bun install --frozen-lockfile
bun run dev:local
```

The launcher downloads the local Convex backend if necessary. Its database, files and generated development secrets stay under `sherlock/app/.convex-local/`, which is ignored by Git. No production credentials are needed for this mode.

Open the local URL printed by the launcher. Local development identities are a development testing tool, not an authentication system for a public deployment. Do not expose this development server to the internet.

A normal startup does not load any company's documents. To deliberately create fictional development records while the local backend is running:

```sh
bun run seed:local
```

The sample records and documents are synthetic. They are not customer records or investment recommendations.

## Run your own hosted installation

Read [the self-hosting guide](docs/self-hosting.md). Configure your own service accounts, URLs and secrets. The repository only contains a blank [configuration example](sherlock/app/.env.example).

Sherlock was built with Convex and WorkOS, and they are the supported starting point. You can use hosted Convex or investigate its self-hosted backend. Replacing the database or authentication provider requires an integration change; the project does not claim that every provider already works.

PostHog analytics and Resend email integrations are included. Analytics is optional and must use your own project. Email-dependent invitation flows require a configured email sender. Provider plans, free allowances and terms apply to each operator separately.

An independent installation does not send its users, documents or telemetry to the official Sherlock installation by default.

## Development checks

```sh
bun run typecheck
bun run lint
bun run test
```

Production builds require an explicit HTTPS application address. For a local compilation check:

```sh
NEXT_PUBLIC_APP_URL=https://sherlock.example.invalid bun run build
```

The reserved `.invalid` address is only for this check. For a hosted installation, use its actual HTTPS address and configure the services in [the self-hosting guide](docs/self-hosting.md). A successful build does not verify hosted authentication or email delivery.

Tests use fictional fixtures and mocked service boundaries where appropriate. See [contributing](CONTRIBUTING.md) and [security](SECURITY.md).

## Repository checks and open-source services

Checks remain manual. Open **Actions → Verify → Run workflow** and select a runner provider. The default is a standard GitHub Ubuntu runner, whose compute is free for public repositories. The Blacksmith option uses the operator's existing Blacksmith installation and allowance; it is never selected automatically. Forks do not need a Blacksmith account to run the checks.

Both providers run the same locked dependency installation, type checks, lint, and tests. Actions are pinned to commit IDs, checkout credentials are not retained, and only the Bun download cache is saved. No production secrets or deployments are part of verification.

**Actions → Code scanning → Run workflow** runs CodeQL for TypeScript, JavaScript, and GitHub Actions. Code scanning is free for public repositories. Secret scanning, push protection, private vulnerability reporting, and Dependabot alerts are repository settings, separate from a successful CI run.

Dependabot proposes grouped weekly updates for Bun dependencies and SHA-pinned Actions, with at most one open proposal per ecosystem. The patched MOG and Convex dependencies remain under manual maintenance. Updates are never automatically merged. GitHub does not support Dependabot security-update PRs for Bun or vulnerability alerts for SHA-pinned Actions; these update proposals do not establish complete security coverage.

Blacksmith's [OSS sponsorship program](https://www.blacksmith.sh/pricing) has its own eligibility and approval process. An installed Blacksmith app, an available allowance, and approved sponsorship are different states. Neither a Blacksmith allowance nor public-repository status guarantees that GitHub will start a job when the owning account has a billing restriction.

## License

Sherlock is licensed under [Apache License 2.0](LICENSE). Dependency and asset licenses remain applicable; see [third-party notices](THIRD_PARTY_NOTICES.md). The license does not grant control of the official domain or access to any hosted account or customer data.
