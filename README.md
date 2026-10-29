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

## License

Sherlock is licensed under [Apache License 2.0](LICENSE). Dependency and asset licenses remain applicable; see [third-party notices](THIRD_PARTY_NOTICES.md). The license does not grant control of the official domain or access to any hosted account or customer data.
