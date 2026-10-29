#!/usr/bin/env node
// Inventario visual del sitio a 1440x900: una captura por ruta y rol, con el
// alto real de la página y cuántos bloques apila (h2 y secciones con hairline).
// Uso: node scripts/site-screenshots.mjs [--base http://localhost:3100] [--out <dir>]
//      [--routes /es/a,/es/b] [--user <cualquiera>@dev.local|anon]
//      [--scheme light|dark]
// `--scheme` sale en claro: la crema es el lienzo por defecto del sitio
// ([F] 2026-09-11 18:53). El oscuro se pide a mano con `--scheme dark`.
// El nombre del PNG y del TSV sigue ese default: el claro va sin sufijo y el
// oscuro lleva `_dark` (PNG: OB-RES-4; TSV: OB-RES-5).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const base = args.get("--base") ?? "http://localhost:3100";
const out =
  args.get("--out") ??
  join(process.env.HOME, "Developer/sherlock-handoffs/capturas/sitio");
const user = args.get("--user") ?? "anon";
const scheme = args.get("--scheme") ?? "light";

const ROUTES = {
  anon: [
    "/es",
    "/es/ayuda",
    "/es/intake",
    "/es/legal",
    "/es/privacy",
    "/es/terms",
    "/es/sign-in",
    "/es/sign-up",
    "/es/vdr-guest",
  ],
  "company@dev.local": [
    "/es/my-company/documents",
    "/es/my-company/company",
    "/es/my-company/preparation",
    "/es/my-company/team",
    "/es/notifications",
    "/es/settings",
    "/es/settings/privacy",
  ],
  // Las ocho rutas vivas del panel: D2 ([F] 2026-09-11) retiró usuarios, KYC,
  // analitica, auditoria, plantillas NDA y actividad.
  "admin@dev.local": [
    "/es/admin",
    "/es/admin/companies",
    "/es/admin/vdr-requests",
    "/es/admin/support",
    "/es/admin/security",
    "/es/admin/gdpr",
    "/es/admin/nda",
    "/es/admin/workos",
    "/es/notifications",
    "/es/settings",
  ],
};
// Un dueño sembrado con `seed:company` entra igual que `company@dev.local` y
// tiene las mismas pantallas: sin ruta explícita se le capturan esas.
const defaultRoutes =
  ROUTES[user] ??
  (user.endsWith("@dev.local") ? ROUTES["company@dev.local"] : []);
const routes = args.get("--routes")?.split(",") ?? defaultRoutes;

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: scheme,
});
// `colorScheme` solo emula prefers-color-scheme, y la app obedece la
// preferencia guardada en `localStorage.theme` (clara por defecto desde [F]
// 2026-09-11). Sin esta línea, `--scheme dark` capturaba en crema.
await page.addInitScript((theme) => {
  localStorage.setItem("theme", theme);
}, scheme);

const errors = [];
page.on("pageerror", (error) => errors.push(String(error).slice(0, 200)));

if (user !== "anon") {
  await page.goto(`${base}/es/dev-login`);
  await page.locator("#email").waitFor();
  await page.locator("#email").fill(user);
  await page.getByRole("button", { name: "Iniciar sesión" }).click();
  await page.waitForURL((url) => !url.pathname.includes("dev-login"), {
    timeout: 60_000,
  });
}

const rows = [
  ["ruta", "status", "url final", "alto", "h1", "h2", "hairlines", "archivo"],
];
const schemeSuffix = scheme === "dark" ? "_dark" : "";
const userSlug = `${user.split("@")[0]}${schemeSuffix}`;
for (const route of routes) {
  // Una ruta que redirige a mitad de carga aborta el goto; se anota y se sigue.
  const response = await page
    .goto(`${base}${route}`, { waitUntil: "domcontentloaded" })
    .catch((error) => ({
      status: () => `ERR ${String(error.message).split("\n")[0].slice(0, 40)}`,
    }));
  await page.waitForTimeout(3000);
  const metrics = await page.evaluate(() => {
    const wide = (element) => element.getBoundingClientRect().width > 600;
    const hairlines = [...document.querySelectorAll("main *")].filter(
      (element) => {
        const style = getComputedStyle(element);
        return (
          wide(element) &&
          ((style.borderTopWidth !== "0px" &&
            style.borderTopStyle !== "none") ||
            (style.borderBottomWidth !== "0px" &&
              style.borderBottomStyle !== "none")) &&
          !["INPUT", "TEXTAREA", "BUTTON", "SELECT"].includes(element.tagName)
        );
      },
    ).length;
    return {
      height: document.documentElement.scrollHeight,
      h1: document.querySelectorAll("main h1").length,
      h2: document.querySelectorAll("main h2").length,
      hairlines,
    };
  });
  const slug = `${userSlug}${route.replace(/\//g, "_")}`;
  const file = join(out, `${slug}.png`);
  await page.screenshot({ path: file });
  const row = [
    route,
    response?.status(),
    page.url().replace(base, ""),
    metrics.height,
    metrics.h1,
    metrics.h2,
    metrics.hairlines,
    file,
  ];
  rows.push(row);
  console.log(row.slice(0, 7).join("\t"));
}
writeFileSync(
  join(out, `${userSlug}.tsv`),
  rows.map((row) => row.join("\t")).join("\n") + "\n",
);
await browser.close();
if (errors.length > 0) console.error(`pageerrors:\n${errors.join("\n")}`);
