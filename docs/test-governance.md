# Works-first test governance

Applies during Sherlock's current pre-product phase. Tests are strong evidence;
they are not automatic authority to regress approved current behavior.

## Adjudicate every red

Before editing production behavior, record the evidence and classify the red:

- `REAL_PRODUCT_BUG`: the product violates compliance/product doctrine, an
  approved current code boundary, or a fresh human/browser acceptance journey.
- `STALE_TEST`: the expectation encodes retired behavior or private structure
  instead of current observable truth.
- `ENVIRONMENT/FIXTURE`: setup, state, credentials, data, or fixture isolation
  invalidates the result.

Only `REAL_PRODUCT_BUG` authorizes a production-behavior change. In a conflict,
compliance/product doctrine, current code boundaries, and a fresh human/browser
acceptance journey outrank a stale expectation; `docs/compliance.md` still wins
every conflict under `docs/AGENTS.md`.

## Preserve the contracts that protect the product

Preserve and strengthen auth, ownership, fail-closed behavior, data integrity,
digest/idempotency, MCP contracts, incident regressions, and real user journeys.
A green run never justifies weakening or deleting one of those protections.

Tests assert observable behavior and name the production break they catch.
Update or remove stale source greps, exact-copy/snapshot expectations,
retired-route or funnel expectations, and private-structure change detectors
when they contradict current truth.

## Verify only at the pre-merge gate

- Per commit / push / open PR: no automatic gate.
- Pre-merge to `main`: one verification window, after Maintainer orders it.
- `verify:quick`, `verify:local`, coverage and E2E never run as automatic follow-ups.

Do not repeat suites or browser matrices after each change or wave. A general order to
finish the work does not authorize a test run; Maintainer names the run when the candidate
is ready to integrate. The fresh human/browser acceptance journey below remains the
product gate when he requests it.
Automated E2E fixtures stay isolated from seeded local Convex; contaminated
fixture state is `ENVIRONMENT/FIXTURE`, not a reason to rewrite working product.

The acceptance journey is concrete. Its scripted form is
`sherlock/app/e2e/journeys/j1`–`j5`, which `bun run journeys:local` times against
the local bank:

- **A, company entry (`j1-dopamine`):** `/` inline upload selects real files, real
  WorkOS auth lands in the permanent company room, and the selected documents are
  durable there.
- **B, company room (`j2-sala`):** folder tree, upload/rename/move/archive, details,
  and PDF/DOCX/XLSX-Mog/PPTX/image viewers work on real files. No assistant.
- **C, team (`j3-equipo`):** every live admin route shows truthful preparation and VDR
  operations in Spanish, without retired marketplace metrics or inert zero-table
  theater, and the `vdr:pull` / `vdr:push` loop round-trips a deliverable.
- **D, guest (`j4-invitado`):** invitation, OTP, NDA, read-only room, and revocation
  fail closed without exposing a document after access ends.
- **E, client MCP (`j5-mcp`):** the client connects `/api/vdr-mcp` with its own token
  and gets answers from `sala_resumen`, `documento_buscar` and `modelo_resumen`. No
  browser: this one is the terminal path.

## Keep verification named, not automatic

Verification and CodeQL scanning use `workflow_dispatch`, named by Maintainer
before integrating to `main`. Verification defaults to a standard GitHub runner
for public-repository portability; Blacksmith requires explicit selection and
the operator's own enabled installation and allowance. There is no automatic
provider fallback. There is no Buildkite. Husky `pre-commit` / `pre-push` / `commit-msg`
are `exit 0`. Build, coverage, browser matrices, product journeys, live Convex
integration, observability, autofix, and extra review-bot runs remain manual or
opt-in. Maintainer controls pushes, merges, and deployments.

Repository-level secret scanning, push protection, private vulnerability
reporting, and Dependabot alerts are separate from workflow execution.
Dependabot proposes grouped weekly updates but never merges them; patched MOG
and Convex packages are excluded from automated updates. There is at most one
open proposal per ecosystem, keeping the Bun and Actions update paths separate.
GitHub does not provide security-update PRs for Bun or vulnerability alerts for
SHA-pinned Actions. Update proposals do not replace security review.

Batch valid feedback into one correction push. A normal PR therefore consumes
at most one initial cloud cycle and one correction cycle; additional runs need
a concrete reason recorded in the PR.

The daily drift check is read-only: inspect workflow enabled state, tests around
changed or removed surfaces, and route/browser evidence. It proposes recorded
adjudications; it never rewrites tests to manufacture green or changes external
state.
