# Design System

Status: binding product contract
Canonical path: `docs/design-system.md`
Executable token source: `sherlock/app/src/app/globals.css`
Reglas vigentes: `llm-wiki/bundle/governance/current-rules.md`
Last reviewed against the code: 2026-09-17

## Authority and scope

This file is the sole canonical visual and interaction contract for Sherlock. Root `AGENTS.md`
(which `CLAUDE.md` imports) summarizes it; they do not create a second design system. Code may be stricter for
security, disclosure, role, ownership, compliance, or browser constraints.

The contract covers the surfaces that ship today: the public landing, the hosted-auth handoff,
intake, onboarding, settings, notifications, admin (companies, support, security, GDPR, WorkOS),
legal and help reading, and the loading, empty, error, denied and success states of all of them.

The VDR domain is deliberately excluded from redesign here. Shared tokens and primitives may
improve VDR incidentally, but VDR information architecture, access logic, CTA flow and room
experience belong to the dedicated VDR program. Its binding contract is
`docs/design-system-vdr.md` (one screen per intent under `/my-company/*`). Compliance and issuer disclosure always win over
visual convenience.

Order of authority:

1. `docs/compliance.md` and current authorization/disclosure code.
2. This file for visual, responsive, accessibility, motion and interaction behavior.
3. The rule in force in `llm-wiki/bundle/governance/current-rules.md`.
4. Visual evidence measured against the current tree as supporting snapshots.

## Aesthetic guard

Sherlock should feel like a restrained private bank plus a serious financial magazine: calm,
editorial, exact, discreet and human. It must not resemble a crypto exchange, public crowdfunding
board, generic AI SaaS landing page, social network or trading terminal.

Non-negotiable:

- No decorative gradients.
- No glassmorphism or translucent decorative panels.
- No bokeh, glow, orb, mesh or noise backgrounds.
- No excessive pills, floating chips, card grids or rounded containers.
- No decorative motion, parallax, auto-rotating carousels or attention loops.
- No heavy shadows, neon focus, gamification, confetti, emojis or novelty cursors.
- No public-investing actions such as “Invest now”, “Buy”, “Fund this” or “Commit”.
- No return promises, urgency theater, artificial scarcity or crypto/trading language.

Positive direction:

- One clear editorial hierarchy per view.
- Generous but purposeful whitespace.
- Thin rules, aligned baselines and restrained functional elevation.
- Issuer-controlled disclosure, explicit state and human review shown in the interface.
- Trust through provenance, freshness, scope, support and understandable next steps.
- Product density where work is dense; editorial breathing room where comprehension matters.

## Design tokens

`sherlock/app/src/app/globals.css` is the executable source. Product code consumes semantic tokens;
it does not introduce isolated brand hexes.

### Brand palette

Brand System v1.0 ([F] 2026-08-28). The palette is six pigments and **one hex per colour**.
Every intermediate tone (border, secondary text, filled surface, hover) is an _opacity_ of one of
those six, expressed as `color-mix(in srgb, ...)`. A new hex is a contract violation, not a shade.
`in srgb` is deliberate: it reproduces the values published in the brand kit; oklab yields
different numbers.

| token                   |     value | contract                                              |
| ----------------------- | --------: | ----------------------------------------------------- |
| `--brand-burgundy`      | `#5A2331` | brand; accent in light, elevated surface in dark      |
| `--brand-burgundy-deep` | `#250E14` | dark canvas only; same hue as burgundy at L=10%       |
| `--brand-ochre`         | `#C0873A` | highlight; never body text on crema (2.80:1)          |
| `--brand-cream`         | `#F6F3EC` | light canvas and card; inverse text in dark           |
| `--brand-navy`          | `#0E1A2B` | light body text, focus ring, borders via alpha        |
| `--brand-grey`          | `#6A7689` | borders, icons, chart axes, metadata; never body copy |

Two status hexes sit outside the six because the system defines no error red or amber:
`--status-danger` (`#8F4D3F`, the only non-pigment hex, reserved for `destructive`) and
`--status-warning`, derived as ochre 70% toward navy so it clears AA as text. `--paper`
(`#FFFFFF`) is a document affordance for viewers rendering a printed page, not a brand colour.

**Retired, never to be reintroduced:** `#F1EFE8`, `#A06F2D`, `#C9674F`, `#E1D4D6`, `#20201C`,
`#5F5256`, `#8F7A7B`, `#B08A4A`, and the `wine` / `plum` / `blush` / `champagne` / `mauve` /
`terracotta` / `winenight` / `inkwine` aliases. They were opacities disguised as colours, or
second names for a pigment that already existed.

**Light ↔ dark inversion.** Crema and Burgundy Deep swap the canvas role. Navy and Burgundy swap
the accent role. Ochre and grey never change: they are the two anchors that keep the brand
recognisable in both modes. Navy retires as text in dark (1.04:1 on burgundy deep); its only dark
job is labelling ochre buttons.

| role                    | light                   | dark                                 |
| ----------------------- | ----------------------- | ------------------------------------ |
| canvas                  | crema                   | burgundy deep                        |
| card / pill / surface   | crema + border          | burgundy                             |
| body text               | navy — 15.8:1           | crema — 16.5:1                       |
| secondary text          | navy 70% — 6.2:1        | crema 70% — 8.4:1                    |
| metadata / icons / axes | grey — 4.15:1, non-body | grey on canvas only — 3.96:1         |
| link / CTA / accent     | burgundy — 11.0:1       | ochre-text — 6.97 canvas / 4.67 card |
| highlight               | ochre                   | ochre                                |
| label on accent         | crema on burgundy       | navy on ochre — 5.6:1                |
| hairline border         | navy 12%                | crema 42% (see below)                |
| focus ring              | navy — 15.8:1           | ochre — 5.9:1                        |

**Four prohibitions**, pinned by `src/__tests__/styles/brand-theme-contrast.test.ts`:

1. Ochre is never text on crema (2.80:1). It lives in button fills, 1px rules, icons ≥24px,
   display figures ≥36px and the highlighted point of a chart.
2. Grey is never text on burgundy (2.66:1). Secondary text inside a dark card is crema 70%.
3. Navy and burgundy never share a surface (1.43:1). A section picks one.
4. Pure ochre is never small text on a burgundy card (3.93:1). The 5.88:1 the brand system
   publishes for dark ochre is measured against the _canvas_. Semantic tokens that can carry text
   in dark (`--primary`, `--accent`, `--warning`, `--badge-fg`, `--sidebar-primary`) resolve to
   `--ochre-text`, ochre lifted 15% toward crema (4.66:1 on the card, 6.96:1 on the canvas). Pure
   ochre stays wherever 3:1 is the bar: fills, 1px rules, icons, display figures, the focus ring,
   chart series and the isotipo's S.

**Documented deviation.** The brand system specifies crema 15% for dark borders; this contract
keeps **42%**. In dark the border _is_ the structure, because canvas and card separate only
1.49:1. Crema 15% measures 1.51:1 on the card and the room reads without a frame; 42% measures
3.20:1 and holds the 3:1 non-text-contrast invariant in force since 2026-07-28.

**Proportion:** 70% canvas, 18% text, 8% burgundy, 4% ochre. Ochre at 4% is what keeps it
expensive.

Semantic roles (`background`, `card`, `foreground`, `muted`, `border`, `primary`, `accent`,
`destructive`, `success`, `warning`, `info`, `ring`, `chart-*`) must retain meaning across themes.
Changing theme may change luminance, not the meaning of a status.

### Surfaces and elevation

- Light canvas: crema. Elevated surfaces share the canvas and separate by 1px border plus
  whitespace; floating surfaces (popover, dropdown, dialog) add `shadow-md`, never a fourth tone.
- Dark canvas: burgundy deep. Elevated surfaces: one burgundy; do not invent competing wines.
- Default separation is whitespace plus a 1px border.
- `shadow-sm`: functional card/selected-navigation separation only.
- `shadow-md`: temporary hover, popover or disclosure elevation only.
- `shadow-lg`: dialog, sheet or blocking banner only.
- Decorative shadows and permanent hover “lift” on passive content are prohibited.

### Radius

Target base radius is 8px. Controls and cards use 4–8px. Full rounding is allowed only for avatars,
status dots, progress tracks and compact status badges whose shape carries meaning.

Navigation, filters and buttons are not pill-shaped by default. The current 10px CSS base and broad
`rounded-lg` use are tracked debt; do not expand that debt.

### Spacing and density

Use the 4px grid: 4, 8, 12, 16, 24, 32, 48, 64 and 96. Prefer one strong gap over nested ad-hoc
padding. Standard control height is 40–44px; primary mobile actions target 44px. Dense tables may
use 32–36px rows when focus, touch and text remain usable.

### State colors

State must never depend on hue alone. Pair color with an icon, label, pattern, border or shape.
“Approved” always names the approved scope (for example, “Identity disclosure approved”), never
transaction eligibility or investment approval.

## Typography

Families:

- Display: self-hosted Fraunces for wordmark and major editorial h1/h2 only.
- UI: the existing sans stack for labels, navigation, forms, tables and body copy.
- Data: JetBrains Mono for record identifiers and machine-relevant values.

Canonical scale: 12, 14, 16, 18, 24, 32, 48, 64px, plus 36 px (`text-4xl`) as the single public-hero exception ([F] 2026-09-10).
`globals.css` sets the base hierarchy to it (h1 32 / h2 24 in Fraunces, h3 18 semibold in the UI sans). D-009 closed 2026-09-03.

Editorial devices (Brand System §3 and §5), shipped as utilities in `globals.css`:

- `.eyebrow`: JetBrains Mono 500, 12px caps, tracked, accent colour. At most one per section,
  naming the section's kind. Nothing else is set in caps.
- `.rule-editorial`: ochre, 1px, 48px wide, under an h1/h2. One per surface. This is where ochre
  lives as geometry; it is never text.
- Display figures ("2 de 7", KPI counts, step numerals) use `font-display` in navy (light) / crema
  (dark), never ochre below 3:1 on the canvas.
- The brand renders only through `SherlockLockup` (header, sheets, footer, covers). The isotipo
  alone is the favicon (`public/favicon.svg`); mark and wordmark paths live in `brand-paths.ts` for a
  future consumer. The wordmark is never typed in Fraunces;
  `src/__tests__/architecture/brand-wordmark-contract.test.ts` pins this.

- One h1 per page.
- Public hero h1 uses `text-4xl` (36 px) by [F] 2026-09-10; 48/64 are retired from public heroes.
  It must not push the complete primary action beyond a 900px-tall first viewport.
- Authenticated h1: 24–32px. Section headings: 18–24px.
- Body: 16px default, 1.5–1.65 line-height; 14px for secondary product copy.
- 12px is metadata only, never required instructions or disclosure.
- Avoid all caps except short eyebrows/status stamps with tracking and plain-language equivalents.
- Human-facing financial figures use the UI sans with lining, tabular figures; JetBrains Mono is
  reserved for IDs, hashes, timestamps and machine-facing values. Align decimals or right edges;
  never compare values through proportional whitespace alone.
- Avoid manual `<br>` line composition that breaks localization. Use intrinsic wrapping and
  `text-wrap: balance` only for short headings.

## Layout and responsive behavior

Mobile-first acceptance widths are 320, 375, 768 and 1280 CSS px. Browser zoom acceptance is 200%
and 400% (320 CSS px equivalent at 1280/400%). No page may create body-level horizontal overflow.

- Public/editorial content max width: 72rem. Long-form legal/help reading measure: 60–75 characters.
- Authenticated working canvas max width: 80rem (`max-w-7xl`), the shared container below.
- 375: one primary column; actions stack or wrap; secondary metadata may collapse.
- 768: two-column composition only when both columns remain readable and the focus order is linear.
- 1280: side rail or secondary context may appear; the primary task remains visually dominant.
- Tables that require two dimensions use an explicitly labeled `overflow-x-auto` region reachable
  by keyboard. Body overflow is never the table solution.
- Shared table cells wrap by default for prose; nowrap is reserved for IDs, compact dates and
  numeric values.
- The admin support inbox uses a one-pane mobile flow (thread list then thread) and splits into two
  columns only from `lg`, never two fixed panes squeezed into 375px.
- Admin sidebars collapse into a labeled navigation control; controls retain at least 24px target
  size/spacing and primary actions target 44px.
- Truncation is safe for repeated metadata only. Never truncate actions, errors, legal disclosure,
  identity state or amounts without an accessible full value.
- Locale switching preserves route, query, hash, selected filters/pagination and in-progress form
  values where technically possible.

## Screens and canvas

Binding since [F] 2026-09-11 18:53 (`llm-wiki/bundle/governance/current-rules.md`), generalizing the room contract in
`docs/design-system-vdr.md` to every product and public surface. Pin test:
`sherlock/app/src/__tests__/architecture/design-system-screens-contract.test.ts`.

Canvas:

- Cream `#F6F3EC` is the light canvas. A visitor with no stored preference follows the operating
  system (`system`), per [F] 2026-09-14, which restores [F] 2026-09-03 and supersedes the cream
  default of 2026-09-11. The account menu keeps the three named modes (`light`, `dark`, `system`),
  and since [F] 2026-09-17 the authenticated bar also carries a direct control from the `xl`
  breakpoint: icon only, with its accessible label, the same component the public bar uses. Below
  `xl` the control stays inside the named compact menu. `THEME_BOOT_SCRIPT` and `ThemeProvider`
  share this default.
- Burgundy deep `#250E14` exists only as the dark-mode canvas. It is never a surface, card or band in
  light mode.
- Each pigment has one role. Burgundy: what the user touches (primary button, active tab, wordmark,
  links). Ocre: one accent per screen (progress, the figure that matters, the current step). Gris:
  secondary text, hairlines, metadata. Navy: body text on cream. Cream: canvas, and text on dark.
  Colour never decorates; a pigment appears because its role is on screen.
- Measured target on a 1440x900 capture in light mode: canvas at least 75% of pixels, burgundy
  under 15%, ocre under 3%. `bun run screens:sitio` writes the capture; the pigment share is
  measured from it.

Screens:

- One screen per intent. A route answers one question for its reader and fits 1440x900 without
  page scroll, except forms and long-form reading (legal, help articles), which scroll inside a
  single column of at most 72rem.
- Blocks are not stacked under a primary surface. When two blocks need a rule between them they
  are two screens, two tabs or two routes. Hairlines separate rows inside a list only.
- One display (Fraunces) title per screen. Sub-blocks use the text face at 14 or 16px, semibold.
- A form keeps its only submit in a footer visible without scrolling (sticky at the bottom of the
  form container). A save button never sits alone after a rule.
- Static and dynamic content look different: a row without state is not a row; placeholders and
  future items collapse into one muted line. Read-only data renders as text with a label, never as
  a disabled input.
- Tables over cards for repeated objects. A card is one bounded object, state or decision, and a
  card never contains another card.
- Product chrome and content share one container, `mx-auto max-w-7xl px-4 sm:px-6 lg:px-8`, so the
  wordmark and the content's left edge sit on the same column. Admin keeps its sidebar shell and
  the same container for its content column.
- Type scale is short and fixed: the canonical scale of `## Typography`. 12 (metadata), 14 (UI
  text), 16 (body), 24 (section display, h2), 32 (page display, h1), and 36 only in the public
  hero. Nothing between.
- Data views use real charts. The installed engine is Recharts under the `shadcn/ui` chart
  primitive (`src/components/ui/chart.tsx`), coloured with the six pigments per
  `## Data visualization`, never numbers-in-cards pretending to be a chart.

Sourcing:

- Blocks published to be copied (MIT/Apache: shadcn/ui blocks and charts, Tremor, Origin UI) may
  be pasted whole and recoloured with the tokens in `globals.css`. Markup, styles or assets from
  other companies' sites are never copied.

### Landing mock B, approved exception of 2026-09-14

Maintainer corrected the mock B specification later on 2026-09-14. The complete initial landing, including navigation, upload, MCP, deliverable examples, short deliverables text and footer, fits a laptop viewport. There is no lead paragraph, repeated final CTA or separate steps section. The single help link reads `Ayuda y cómo funciona`.

The headline is 28px on desktop and 24px on mobile, in burgundy over an ochre-and-cream highlight on each line. The upload and MCP chambers remain one object. The MCP chamber uses burgundy deep in both themes. The document previews use the existing pigments, visible titles and an explicit illustrative-example label. Their miniature data typography is separate from the functional page text.

This correction supersedes the earlier 40px headline and three 40px-padded editorial sections. It does not change legal wording, routes, authentication or the client MCP endpoint. Product batch limits of twenty files and 250 MB are retired across selection, temporary custody and claim. Per-file validation, session authority, inspection and idempotency remain in force.

## Component anatomy and states

Every reusable component and routed workflow defines these states when applicable:

1. default/success,
2. hover/pressed/selected,
3. focus-visible,
4. disabled/read-only,
5. loading,
6. empty,
7. error/retry,
8. denied/pending human review.

### Buttons and links

- One primary action per decision region.
- Labels state the next action: “Request access”, “Review disclosure”, “Retry”.
- Destructive actions name the consequence and require confirmation.
- Icon-only controls require localized accessible names and 24px minimum target/spacing.
- Links navigate; buttons mutate or reveal UI. Do not style passive cards as buttons.

### Cards and containers

- A card represents one bounded object, state or decision. It is not the default wrapper for every
  section.
- Card hierarchy comes from spacing, heading and border before shadow or background.
- Card titles must be semantic headings when they establish document structure.

### Forms and onboarding

- Visible label, instruction and error are programmatically associated.
- Required status and format are stated before submission.
- Validation preserves entered values, identifies each item and proposes a fix.
- Error summaries receive focus only after failed submission; passive status does not steal focus.
- Multi-step flows show current step, completed steps and what is saved.
- Password managers, paste and one-time-code autofill remain available.

### Loading, empty, error and denied

- Loading skeletons mirror final structure. Shimmer is a loading-only exception and must become
  static under reduced motion.
- Empty states explain what is empty, why it matters and one honest next action.
- Error UI never exposes stack traces, raw provider errors, PII or internal record details.
- Error boundaries share one translated foundation in `es`.
- Denied states distinguish missing role, ownership, disclosure, NDA, pending review and unavailable
  resource without revealing hidden data.
- Async status uses a persistent polite live region; urgent actionable failures may use `role=alert`.

### Navigation, dialogs and toasts

- Navigation has a skip link, landmark label, current-page state and predictable mobile focus order.
- Dialogs have a label/description, initial focus, Escape behavior and focus restoration.
- Toasts are short, factual and supplementary. Critical instructions remain in the page.

## Accessibility

Target: WCAG 2.2 AA across both themes and both languages.

- Text contrast: 4.5:1 normal, 3:1 large. UI boundaries, icons and focus: 3:1.
- Keyboard: all actions reachable by Tab/Shift+Tab; no trap; logical order; standard exit behavior.
- Focus: never remove focus indication; the ring is navy in light and ochre in dark, and both
  clear 3:1 against every surface in their theme.
- Reflow: no loss or two-axis page scrolling at 320 CSS px/400%, except genuinely two-dimensional
  data tables.
- Targets: meet WCAG 2.2 24px target/spacing rule; aim for 44px on primary mobile actions.
- Structure: one h1, semantic headings, landmarks, lists and proper table header associations.
- Status: announce loading completion, saved state, errors and filter-result changes once.
- Screen reader smoke: VoiceOver + Safari for every changed route family; NVDA + Chrome before a
  public release when available.
- Language: `<html lang>` and localized accessible names match the rendered language; inline language
  changes are marked.
- Authentication follows WCAG 3.3.8: do not require a cognitive-function test without an alternative.
- Automated axe/DOM checks are a prefilter, not proof; manual keyboard, zoom, contrast and screen
  reader evidence remain mandatory.

## Motion

Motion explains state change; it never decorates status.

- Fast feedback: 120ms. Standard transition: 180ms. Complex disclosure: 240ms maximum.
- Animate opacity and transform only unless a measured layout transition requires otherwise.
- No looping ambient motion, pulsing glow, bouncing CTA, parallax or chart animation on load.
- Hover transforms apply only to actionable controls and never move surrounding layout.
- Loading shimmer is the sole sanctioned animation exception. The landing entrance is bounded to
  220ms and its former decorative status pulse is static.
- With `prefers-reduced-motion: reduce`, remove nonessential animation, transform and smooth scrolling;
  preserve state changes instantly.
- Errors do not shake. Success does not celebrate. Theme changes do not flash or crossfade the page.

## Data visualization

Charts support a decision; they are not decoration.

Every chart or financial figure includes:

- neutral title,
- one-sentence takeaway,
- unit/currency and denominator,
- as-of date/window,
- source and material exclusions,
- estimate/provisional marker where relevant,
- semantic table or equivalent complete text alternative.

Rules:

- Never rely on color, hover or browser `title` alone.
- Keep series names visible with direct labels or a clear legend.
- Preserve stable series meaning across themes.
- Use text, pattern, stroke or shape as a second encoding.
- Axis/scale starts, truncation and uncertainty are explicit.
- Compact values are locale-aware display only; the accessible/table value is complete.
- Mobile prioritizes summary and key value; detailed tables scroll inside a labeled region.
- Table headers use `scope`; numeric columns align right; captions explain grain and timeframe.
- Chart transitions obey reduced motion and are never required to read a value.

## Internationalization

Spanish is the only locale ([F] 2026-09-03). There is no second locale.

- Every figure formats as `es-PA`, whatever route the caller lives in
  (`src/lib/i18n/formatters.ts`).
- Money formatters accept locale plus ISO currency. Do not manually prefix symbols or hardcode K/M/B.
- Dates use explicit locale and timezone rules. Avoid ambiguous numeric-only dates.
- Message catalogs preserve key and ICU-placeholder parity.
- No visible text, placeholder, `title` or accessible name is hardcoded in localized production UI.
- Do not use a fixed “Spanish expands by N%” rule. Use intrinsic layouts and worst-case real copy.
- Test long issuer names, unbroken IDs, negative/large currency, NBSP output and legal paragraphs.
- Spanish voice is Panamanian tuteo: `tienes`, `puedes`, `revisa`; never voseo (`tenés`, `podés`,
  `revisá`, `vos`) or peninsular plural (`vosotros`).
- Domain terms follow `CONTEXT.md`: Company, Company library, Company room, Guest, Capital
  readiness, Deliverable, Progressive access, Principal, Field visibility, Document, Document
  version and Document publication. The room is one per company, so "Deal room" and the rest of
  the per-transaction vocabulary only survive under "Older cited terms" in `CONTEXT.md`.
- Avoid “Investor type”, “accredited user”, “public listing”, “privacy level”, “invest”, “commit” and
  “deal desk” in user-facing copy.

## Showcase examples

The design contract is verified through a non-production primitive/state showcase or equivalent
component harness. It must include:

| family      | required examples                                                        |
| ----------- | ------------------------------------------------------------------------ |
| Foundations | palette, typography, spacing, radius, elevation, light/dark              |
| Controls    | buttons, links, inputs, select, tabs, menu, theme control               |
| Feedback    | skeleton, live status, toast, empty, error, denied, pending review       |
| Content     | editorial heading, teaser, company card, legal/help prose               |
| Data        | KPI, compact/full money, semantic table, chart summary/table alternative |
| Shell       | public nav, authenticated nav, admin mobile nav, messaging single-pane   |

Each example shows default/focus/disabled/loading/error where applicable, reduced motion and
375/768/1280 behavior. The harness is disabled in production and contains no real data.

Implementation status: `/[locale]/design-system` provides the non-production, synthetic harness
with independent page and proxy production 404 gates. The final verification covers
light and dark themes, 320/375/640/768/1280 reflow, keyboard and pointer interaction,
reduced motion, target size and spacing, Chrome accessibility-tree semantics, a bounded real
VoiceOver smoke, and the loading/empty/error/denied/pending/success state set. D-004 is closed.

## Accepted design debt

Accepted debt is explicit, bounded and may not expand:

| id    | debt                                                                                                                                                                                                                                 | boundary                                                                                                | exit evidence                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| D-001 | CSS `--radius` base is 10px; 23 non-VDR source-scope `rounded-lg` matches on 2026-09-17, under the ratchet of 198 in the pin test                                                                                                                                                      | existing components only                                                                                | 8px token migration with reviewed visual matrix                                           |
| D-002 | Loading shimmer is live in `premium-skeleton.tsx`, whose only consumer is the navbar                                                                                                                                                                       | loading only; static under reduced motion                                                               | token-driven static/skeleton review                                                       |
| D-003 | `premium-skeleton.tsx` contains dead variants and latent blur                                                                                                                                                                        | no new consumers                                                                                        | remove/deprecate after import-graph-safe cleanup                                          |
| D-005 | `/es/sign-in` redirects to `/login`, which sends the user to the hosted AuthKit page in the browser language; production fallback locale is `es-419` (verified in WorkOS 2026-09-12), so an English-first browser still sees English | AuthKit SDK exposes no locale option (`GetAuthURLOptions`, `UserManagementAuthorizationURLBaseOptions`) | none pending; revisit only if WorkOS adds a forced-locale parameter                       |
| D-006 | Locale formatting is almost unified: the shared `src/lib/i18n/formatters.ts` adapter serves the showcase and 0 legacy `formatCurrencyCompact` matches remain on 2026-09-20, under the ratchet of 30 in the pin test                                                                | all new localized money examples use the adapter; fixed Spanish legal artifacts remain allowed          | migrate remaining non-VDR consumers with focused unit/render tests                        |
| D-012 | 24 non-VDR source-scope `rounded-full` matches on 2026-09-17, under the ratchet of 131 in the pin test                                                                                                                                                                                 | existing semantic badges, avatars, dots, tracks and legacy pill controls only                           | classify consumers and replace decorative/navigation pills without increasing the ratchet |

## Verification

A design change is complete only when the matching surface is observed working.

Minimum code gates, run in the single pre-merge window that Maintainer orders
(`docs/agent-reference/delivery.md`; no agent launches them on its own):

- LSP diagnostics on changed TypeScript,
- typecheck,
- lint,
- the tests of `bun run verify:gate`,
- production build,
- applicable Playwright routes.

Every PR that touches a route under `src/app/[locale]` attaches the table from
`bun run screens:sitio` (route, status, height, h1, h2, hairlines) for the affected role, before and
after. A screen that grows past 900px or gains a stacked block needs a sentence in the PR saying why.

Minimum visual/accessibility gates for changed surfaces:

- light and dark,
- 375, 768 and 1280 CSS px,
- default plus relevant loading/empty/error/denied/success states,
- body overflow check,
- keyboard and focus order,
- 200%/400% zoom,
- reduced motion,
- automated axe prefilter,
- VoiceOver smoke,
- screenshot comparison on the frozen tree.

Performance evidence names build mode, route, browser, viewport, cache/network condition, run count
and metric source. Local Lighthouse/CDP is lab evidence, never field Core Web Vitals. Generated
reports, screenshots and traces stay out of source; durable outcomes are distilled into `llm-wiki/bundle/`.

Any contract change edits this file and the matching rule in `llm-wiki/bundle/governance/current-rules.md`
in the same commit.
