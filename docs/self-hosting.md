# Run your own Sherlock installation

Your installation uses the same code as the official service. Your accounts, URLs, database and user records are separate.

## Configure the services

1. Install the pinned Node.js and Bun versions and run `bun install --frozen-lockfile` from the repository root.
2. Create or select your own Convex deployment. Keep development and production deployments separate.
3. Create your own WorkOS AuthKit project. Configure the callback address and allowed redirect addresses for your installation. Keep the API key, cookie password and webhook secret private.
4. Copy `sherlock/app/.env.example` to `.env.local` in the same directory and supply your own values. Never commit that populated file.
5. Configure the corresponding server secrets in your Convex deployment. The application and backend must agree on signing secrets and audiences.
6. Configure your own Resend sender when using email invitations. Configure your own PostHog project only if you want analytics.

`NEXT_PUBLIC_APP_URL` is your application's public address, including the scheme. Production must have a valid explicitly configured address. It must not point to the official Sherlock service unless you operate that service. Your OAuth callback URLs, guest links and MCP endpoint must all point to your installation.

`NEXT_PUBLIC_*` values are exposed to browser code. Never put a server API secret in such a variable. The local Convex development admin value is deliberately limited to the loopback development environment and must not be enabled in production.

The repository contains no prepared customer database. Do not import someone else's production export to get started.

## Publish your application

Use your own hosting project. The Next.js application directory is `sherlock/app`; install dependencies from the workspace root. The included Vercel configuration is a starting point for your own project and does not connect to the maintainer's account.

Review `sherlock/app/scripts/vercel-build.sh` before enabling deployment. Configure a deployment-specific Convex key in the hosting provider's private settings if using that build path. Development bypass flags must be absent or false in production.

Verify authentication, room ownership, document upload and download, email invitations, and your configured MCP client against test records before accepting real documents. Running the local development demonstration is not evidence that your hosted WorkOS configuration is correct.

Set resource and spend limits suitable for your deployment. Login alone does not cap storage, email, traffic or backend operations. Provider free tiers are not an unlimited hosting guarantee.

## Optional integrations and alternatives

- Convex: supported database, realtime and file storage integration.
- WorkOS AuthKit: supported hosted authentication integration.
- Resend: email delivery used by email-dependent flows.
- PostHog: optional analytics, using your own project.
- Upstash: required by default for production shared rate limiting. A single-process deployment can explicitly set `RATE_LIMIT_PROVIDER=memory`; that limiter does not share counters across server instances and is unsuitable for multi-instance hosting.
- MOG packages: pinned document/workbook viewer and reader dependencies. These are libraries, not a connection to the maintainer's service.

Alternative database and authentication implementations are future work. The local Convex backend uses local persistence; that does not mean the application already supports direct SQLite queries as a substitute for Convex.

## Required backend settings for guest email access

Use [the blank backend configuration](convex.env.example) to inventory the Convex settings. Adding a value only to Next.js does not configure the Convex deployment.

Set `CONVEX_ENV=production`, your own `APP_URL`, and independent random values for `GUEST_IDENTITY_HASH_SECRET` and `GUEST_OTP_PEPPER`. These protect stored guest identity hashes and OTP values. Configure the shared application/backend secrets identically on both sides where indicated by the variable names.

For real invitation delivery, set your own `RESEND_API_KEY` and verified `RESEND_FROM_EMAIL`, and explicitly set `RESEND_TEST_MODE=false`. Without those settings, email-dependent guest access will not deliver invitations as a production service. Keep test mode for isolated development only.
