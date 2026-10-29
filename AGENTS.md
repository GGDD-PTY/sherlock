# Working on Sherlock

Sherlock is one open-source application used by independently configured installations.

- Keep account credentials, customer data, private knowledge bases, backups and machine-specific files out of source control.
- Never default operational requests, authentication callbacks or analytics to the author's installation.
- Preserve server-side authentication, company ownership checks, guest access checks, audit logs and document validation.
- Local development bypasses are development-only and must never work in production.
- Use Bun and preserve bun.lock. Keep the existing MOG package pins and patch.
- TypeScript uses Effect at its existing boundaries. Do not edit convex/_generated manually.
- Product copy is Spanish. Follow docs/design-system.md for visual changes.
- Run relevant tests, type checks and lint after changes. Never weaken an assertion to hide a regression.
- Do not deploy, change provider settings, publish data or send external messages without authorization.
