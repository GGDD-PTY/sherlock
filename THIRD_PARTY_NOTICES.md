# Third-party notices

Sherlock uses the packages listed below. Their licenses are separate from Sherlock's project license and remain applicable. Package distributions include their own copyright and license files. Preserve those files when redistributing dependencies or bundled assets.

This inventory covers the application's direct runtime dependencies as installed from the preserved lockfile. It is not a claim that every transitive license has undergone legal review.

| Package | Installed version | Package-declared license |
| --- | --- | --- |
| `@convex-dev/resend` | 0.2.5 | Apache-2.0 |
| `@headless-tree/core` | 1.7.0 | MIT |
| `@headless-tree/react` | 1.7.0 | MIT |
| `@modelcontextprotocol/server` | 2.3.0 | Apache-2.0 |
| `@mog-sdk/sdk` | 0.10.5 | Apache-2.0 |
| `@napi-rs/canvas` | 1.0.8 | MIT |
| `@radix-ui/react-accordion` | 1.2.14 | MIT |
| `@radix-ui/react-alert-dialog` | 1.1.17 | MIT |
| `@radix-ui/react-avatar` | 1.2.0 | MIT |
| `@radix-ui/react-checkbox` | 1.3.5 | MIT |
| `@radix-ui/react-collapsible` | 1.1.14 | MIT |
| `@radix-ui/react-dialog` | 1.1.17 | MIT |
| `@radix-ui/react-dropdown-menu` | 2.1.18 | MIT |
| `@radix-ui/react-label` | 2.1.10 | MIT |
| `@radix-ui/react-popover` | 1.1.17 | MIT |
| `@radix-ui/react-progress` | 1.1.10 | MIT |
| `@radix-ui/react-scroll-area` | 1.2.12 | MIT |
| `@radix-ui/react-select` | 2.3.1 | MIT |
| `@radix-ui/react-slot` | 1.3.0 | MIT |
| `@radix-ui/react-switch` | 1.3.1 | MIT |
| `@radix-ui/react-tabs` | 1.1.15 | MIT |
| `@radix-ui/react-tooltip` | 1.2.8 | MIT |
| `@tanstack/react-table` | 9.2.4 | MIT |
| `@upstash/ratelimit` | v2.0.8 | MIT |
| `@upstash/redis` | 1.38.0 | MIT |
| `@vercel/speed-insights` | 2.0.0 | Apache-2.0 |
| `@workos-inc/authkit-nextjs` | 4.1.4 | MIT |
| `@workos-inc/node` | 10.7.0 | MIT |
| `class-variance-authority` | 0.7.1 | Apache-2.0 |
| `clsx` | 2.1.1 | MIT |
| `convex` | 1.42.0 | Apache-2.0 |
| `convex-helpers` | 0.1.120 | Apache-2.0 |
| `docx-preview` | 0.4.0 | Apache-2.0 |
| `effect` | 4.0.0-rc.112 | MIT |
| `fflate` | 0.8.3 | MIT |
| `jszip` | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| `lucide-react` | 1.22.0 | ISC |
| `next` | 16.4.2 | MIT |
| `next-intl` | 4.13.0 | MIT |
| `pdf-lib` | 1.17.1 | MIT |
| `pdfjs-dist` | 6.2.108 | Apache-2.0 |
| `posthog-js` | 1.434.0 | (Apache-2.0 AND MIT) |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |
| `react-resizable-panels` | 4.2.2 | MIT |
| `recharts` | 3.8.0 | MIT |
| `sonner` | 2.0.7 | MIT |
| `tailwind-merge` | 3.6.0 | MIT |
| `zod` | 4.6.7 | MIT |
| `zustand` | 5.0.14 | MIT |

## Fonts

The included Fraunces and JetBrains Mono fonts use the SIL Open Font License 1.1. Full notices are preserved in [Fraunces license](docs/licenses/Fraunces-OFL.txt) and [JetBrains Mono license](docs/licenses/JetBrains-Mono-OFL.txt). Their reserved font names and redistribution conditions remain in force.

## MOG

The workbook reader and viewer retain their existing pinned package versions and viewer patch. Their package copyright notices and licenses apply to the distributed components.

## Local Convex launcher patch

The pinned Convex CLI has a small distributed patch that passes `--interface 127.0.0.1` and `--disable-beacon` to its local backend. This confines development listeners to the local computer and disables the backend usage beacon. Hosted Convex requests are unchanged. The original Convex package license remains applicable.
