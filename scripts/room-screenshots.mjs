#!/usr/bin/env node
// Capturas de la sala del cliente a 1440x900, una por pantalla, contra el dev
// server local con dev-auth (docs/design-system-vdr.md, «Verification»).
// Uso: node scripts/room-screenshots.mjs [--base http://localhost:3100] [--out <dir>]
//      [--user company@dev.local] [--scheme light|dark] — cualquier `*@dev.local`
//      sembrado con `seed:company` entra igual y abre SU sala.
// `--scheme` sale en claro, igual que screens:sitio: la crema es el lienzo por
// defecto ([F] 2026-09-11 18:53) y el oscuro se pide a mano. El PNG oscuro
// lleva el sufijo `_dark`; el claro va sin sufijo.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2)
  args.set(process.argv[i], process.argv[i + 1]);
const base = args.get("--base") ?? "http://localhost:3100";
const out =
  args.get("--out") ??
  join(process.env.HOME, "Developer/sherlock-handoffs/capturas/sala");
const user = args.get("--user") ?? "company@dev.local";
const scheme = args.get("--scheme") ?? "light";
if (scheme !== "light" && scheme !== "dark") {
  throw new Error(`--scheme debe ser light o dark; recibido: ${scheme}`);
}
const screens = (
  args.get("--screens") ?? "documents,company,preparation,team,guests"
).split(",");

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  colorScheme: scheme,
});
// `colorScheme` solo emula prefers-color-scheme; la app obedece la preferencia
// guardada en `localStorage.theme`. Sin esto, el oscuro salía en crema.
await page.addInitScript((theme) => {
  localStorage.setItem("theme", theme);
}, scheme);
const schemeSuffix = scheme === "dark" ? "_dark" : "";
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error")
    consoleErrors.push(message.text().slice(0, 300));
});
page.on("pageerror", (error) =>
  consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`),
);
await page.goto(`${base}/es/dev-login`);
await page.locator("#email").waitFor();
await page.locator("#email").fill(user);
await page.getByRole("button", { name: "Iniciar sesión" }).click();
await page.waitForURL(/my-company/, { timeout: 60_000 });

for (const screen of screens) {
  const response = await page.goto(`${base}/es/my-company/${screen}`);
  // El websocket de Convex nunca deja la red en reposo: se espera la identidad
  // de la pantalla y un respiro para el primer pintado de datos.
  // El primer compile del dev server puede tardar más de un minuto.
  await page
    .locator("[data-page-identity]")
    .first()
    .waitFor({ timeout: 45_000 })
    .catch(async () => {
      const text = await page.evaluate(() =>
        document.body.innerText.slice(0, 600),
      );
      console.error(
        `${screen}: sin identidad de página. Texto visible:\n${text}`,
      );
    });
  await page.waitForTimeout(2500);
  const height = await page.evaluate(
    () => document.documentElement.scrollHeight,
  );
  const file = join(out, `${screen}${schemeSuffix}.png`);
  await page.screenshot({ path: file });
  console.log(
    `${screen}\t${response?.status()}\t${page.url().replace(base, "")}\tscrollHeight=${height}\t${file}`,
  );
}
await browser.close();
if (consoleErrors.length > 0)
  console.error(`console errors:\n${consoleErrors.join("\n")}`);
