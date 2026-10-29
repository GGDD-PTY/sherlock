# Coding Standards

## Repo Rules

- Primary app: `sherlock/app`.
- JavaScript/TypeScript workflows use `bun`.
- Prefer existing app patterns, helpers, and UI primitives.
- Keep changes focused and avoid broad refactors.
- Do not edit generated Convex files.

## TypeScript

- Strict types.
- Avoid `any`; use `unknown` plus narrowing. `no-explicit-any` is an oxlint error, not a warning.
- Use generated Convex IDs and docs for entities.
- Validate untrusted input from params, JSON, forms, and env.
- **Effect v4 is the default and has no exclusions** ([F] 2026-09-08). It applies to `.ts` and `.tsx`: server, domain, routes, auth, config, schemas, tooling, React and `convex/**`. Never return an unrun `Effect` from a render: build the program in the logic and run it at the edge. `bun run effect:status` reports where adoption stands.
- The only seam between Effect and Convex is `convex/_helpers/effect.ts`, and a test stops a second one from opening. Inside Convex queries and mutations the isolate forbids `Effect.sleep`, timers, `fetch` and dynamic `import()`; actions are exempt.
- Effect v4 renamed a lot of v3 and the typecheck does not catch it. The trap list lives in `docs/agent-reference/operational-traps.md`.

## Security

- Protected queries/mutations must enforce auth, role, and ownership on the server.
- Public endpoints must rate limit.
- Do not expose secrets, stack traces, provider internals, PII, or raw KYC data.
- All sensitive admin actions require explicit approval UI and audit logging.

## Finance Rules

- Validate numbers for `NaN`, sign, and bounds.
- Do not hardcode financial assumptions when a shared constant exists.
- Two decimals for currency, four for ratios. Always show the currency code.
- Never promise a return and never frame anything as a public securities offering.

## Testing

- Add Vitest tests for new mutations, helpers, and compliance logic.
- Add Playwright tests for new user-facing flows.
- Run the narrowest useful check first, then broader checks when the surface is shared.
- Verification and CodeQL run on pull requests targeting `main` and pushes to `main`. Manual runs remain available. Local hooks, browser journeys, production builds, and deployments do not run automatically. See `docs/test-governance.md` for how to adjudicate a red.

## AI Rules

- There is no in-app AI Gateway. The only MCP is the client's VDR MCP at `/api/vdr-mcp`; Mycroft stays outside.
- AI outputs are recommendations, not approvals.
- Human approval is required for KYB, guest access and NDA decisions, and red-flag overrides. KYB is a founder call, not a software gate.
