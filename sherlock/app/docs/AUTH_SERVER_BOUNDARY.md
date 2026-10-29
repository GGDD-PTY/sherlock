# Auth Server Boundary

## Purpose

This app uses a strict boundary for resolving authenticated identity and profile state on the server. The goal is to avoid fragile self-lookups, split auth sources, and accidental permission drift between WorkOS AuthKit, Convex, SSR pages, API routes, and server actions.

**WorkOS AuthKit is the only active provider.** Clerk runtime integration is
retired; optional legacy identity fields remain only to resolve historical data.

## Canonical entrypoints

- SSR pages and server actions:
  - `src/lib/auth/session.ts`
  - `src/lib/convex-auth.ts`
- API routes:
  - `src/lib/api/with-auth.ts`
- Edge / route protection:
  - `src/proxy.ts` (WorkOS AuthKit + next-intl)

## Rules

1. Use `getCurrentUser()` or `requireAuth()` for SSR/server action identity.
2. Use `getAuthenticatedConvex()` or `getCurrentAuthenticatedUserState()` when a server-side path needs authenticated Convex context.
3. Use `requireApiAuth()` for API route auth/role/profile resolution.
4. Treat `AuthUser` from `src/lib/auth/session.ts` as the canonical server-side user shape.
5. Do not use public `api.users.*` lookup queries to resolve “my own” profile from server-side code.

## Disallowed pattern

Do not resolve the current user with a public self-lookup. These six query names are retired and must not come back: `getProfileByClerkId`, `getProfileById`, `getProfile`, `getUserByClerkId`, `getUserByEmail`, and `getUser`. The architecture scan rejects `fetchQuery(api.users.<name>, …)` for each of them.

The session reads are `api.users.getCurrentUserState` and `api.users.getCurrentProfileId`. Both take no arguments. `getCurrentAuthenticatedUserState` reads `getCurrentUserState`. The profile id for this session is `getCurrentProfileId`.

Do not add a new public self-lookup under another name inside SSR pages, server actions, or API routes just to re-discover the current user.

## Allowed exceptions

- Demo auth/bootstrap logic inside `src/lib/auth/session.ts` when `DEV_AUTH_ENABLED`
- Explicit admin/internal lookups for another user, but only through authenticated helpers or internal queries
- Client-side Convex usage where the authenticated browser context is the source of truth

## Enforcement

- `src/__tests__/architecture/server-auth-boundary.test.ts` scans server-side code for forbidden self-lookup patterns.
- Any new exception should be deliberate, documented here, and added to the allowlist in that test.
