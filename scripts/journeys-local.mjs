#!/usr/bin/env node
// ============================================================================
// JOURNEYS LOCAL — los cinco journeys cronometrados contra el banco local
// ============================================================================
// ES: Levanta (o reusa) `dev:local`, siembra lo que falte, corre
//     `sherlock/app/e2e/journeys/*.spec.ts` con Playwright contra ESE servidor
//     y escribe la tabla de tiempos en
//     `~/Developer/sherlock-handoffs/journeys/<fecha-hora>.tsv`.
//
// Cada paso lo cronometra el propio spec con `performance.now()` y registra los
// `console.error` del navegador (ver `e2e/helpers/journeys.ts`). Aquí solo se
// junta todo y se compara con la meta de cada journey.
//
// Sin mocks: los journeys hablan con el backend Convex local de verdad.
//
// Una empresa o diez: los cinco journeys corren igual, y lo que cambia es la
// sala. `--company` mide una empresa por nombre exacto y `--portfolio N`
// siembra las N primeras del portfolio (`seed:portfolio`) y las mide una tras
// otra, en un solo banco. La tabla final trae una fila por empresa. Un journey
// rojo en una empresa no detiene a las demás.
//
// Uso, desde la raíz del repo:
//   bun run journeys:local                       levanta todo y corre los cinco
//   bun run journeys:local -- --base http://localhost:3100
//                                                reusa un dev:local ya vivo
//   bun run journeys:local -- --journey j1       corre uno solo (repetible)
//   bun run journeys:local -- --company "Café Volcán Barú, S. A."
//                                                una empresa del portfolio
//   bun run journeys:local -- --portfolio 10     las diez primeras, en orden
//   bun run journeys:local -- --keep             no apaga el servidor al salir
//
// Puertos por defecto: app 3116, backend 3370 y 3371, para no chocar con el
// `dev:local` del checkout principal (3100/3210/3211).
// ============================================================================

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// El plan del portfolio y la regla del slug viven en `convex-local.mjs`, que es
// quien siembra: aquí se importan para no tener una segunda copia que se
// desincronice del dueño que el seed le pone a cada empresa.
import {
  buildPortfolioSeedPlan,
  MAX_SEED_PORTFOLIO_COMPANIES,
  slugifyCompanyName,
} from "../sherlock/app/scripts/convex-local.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const APP_DIR = path.join(ROOT, "sherlock", "app");
const CONVEX_LOCAL = path.join(APP_DIR, "scripts", "convex-local.mjs");
const JOURNEYS_DIR = path.join(
  homedir(),
  "Developer",
  "sherlock-handoffs",
  "journeys",
);
const COMPANY_NAME = "Journeys, S. A.";
// El perfil con el que se siembra una empresa que no sale del plan del
// portfolio, la empresa fija incluida: es el default de `seed:company`.
const DEFAULT_COMPANY_PROFILE = "completo";

// Las metas de la sección 6 del plan 10/10. Espejo de `JOURNEY_GOAL_MS` en
// `e2e/helpers/journeys.ts`: el spec las usa para su timeout y el resumen para
// decir si la corrida cumple.
const GOALS = { J1: 90_000, J2: 60_000, J3: 120_000, J4: 90_000, J5: 60_000 };
// Cuánto tiene que llevar quieto el sandbox de Convex para dar por terminado el
// push que disparó la última llamada a `convex-local.mjs` (ver `settle`).
const SANDBOX_QUIET_MS = 15_000;
const JOURNEY_SPECS = {
  j1: "e2e/journeys/j1-dopamine.spec.ts",
  j2: "e2e/journeys/j2-sala.spec.ts",
  j3: "e2e/journeys/j3-equipo.spec.ts",
  j4: "e2e/journeys/j4-invitado.spec.ts",
  j5: "e2e/journeys/j5-mcp.spec.ts",
};

export function parseArgs(argv) {
  const options = {
    base: null,
    port: process.env.PORT || "3116",
    cloudPort: process.env.CONVEX_LOCAL_CLOUD_PORT || "3370",
    sitePort: process.env.CONVEX_LOCAL_SITE_PORT || "3371",
    portSet: false,
    cloudPortSet: false,
    sitePortSet: false,
    journeys: Object.keys(JOURNEY_SPECS),
    company: null,
    portfolio: null,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--"))
        throw new Error(`${arg} requiere un valor`);
      index += 1;
      return next;
    };
    switch (arg) {
      case "--base":
        options.base = value().replace(/\/$/, "");
        if (!options.portSet) {
          try {
            const urlPort = new URL(options.base).port;
            if (urlPort) options.port = urlPort;
          } catch {
            // URL inválida: main fallará al pedir ${base}/es.
          }
        }
        break;
      case "--port":
        options.port = value();
        options.portSet = true;
        break;
      case "--cloud-port":
        options.cloudPort = value();
        options.cloudPortSet = true;
        break;
      case "--site-port":
        options.sitePort = value();
        options.sitePortSet = true;
        break;
      case "--journey": {
        const key = value().toLowerCase();
        if (!JOURNEY_SPECS[key])
          throw new Error(`--journey desconocido: ${key}`);
        options.journeys = [key];
        break;
      }
      case "--company": {
        const name = value().trim();
        if (!name) throw new Error("--company requiere un nombre");
        if (!slugifyCompanyName(name))
          throw new Error(`--company no produce un slug usable: ${name}`);
        options.company = name;
        break;
      }
      case "--portfolio": {
        const raw = value();
        if (!/^\d+$/.test(raw))
          throw new Error("--portfolio debe ser un entero mayor o igual a 1");
        const n = Number(raw);
        if (n < 1)
          throw new Error("--portfolio debe ser un entero mayor o igual a 1");
        if (n > MAX_SEED_PORTFOLIO_COMPANIES)
          throw new Error(
            `--portfolio no puede ser mayor a ${MAX_SEED_PORTFOLIO_COMPANIES}`,
          );
        options.portfolio = n;
        break;
      }
      case "--keep":
        options.keep = true;
        break;
      default:
        throw new Error(`argumento desconocido: ${arg}`);
    }
  }
  if (options.company !== null && options.portfolio !== null) {
    throw new Error("--company y --portfolio no van juntos: o una o N");
  }
  return options;
}

function listenerPid(port) {
  const result = spawnSync("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  const pid = (result.stdout || "").trim().split("\n")[0];
  return pid && /^\d+$/.test(pid) ? pid : null;
}

function processEnvText(pid) {
  const result = spawnSync("ps", ["eww", "-p", pid], { encoding: "utf8" });
  return result.stdout || "";
}

function parentPid(pid) {
  const result = spawnSync("ps", ["-o", "ppid=", "-p", pid], {
    encoding: "utf8",
  });
  const parent = (result.stdout || "").trim();
  return parent && /^\d+$/.test(parent) ? parent : null;
}

function envValue(text, name) {
  const match = text.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`));
  return match ? match[1] : null;
}

/**
 * Los puertos Convex del banco que ya escucha en `--base`.
 *
 * `--base` no trae `--cloud-port`. Sin esto, `env` imprime el default 3370 y
 * Playwright habla con un backend que no existe (ECONNREFUSED), aunque la app
 * en el puerto de `--base` esté viva contra 3500.
 */
export function inheritLiveBackendPorts(options) {
  if (!options.base || (options.cloudPortSet && options.sitePortSet)) {
    return options;
  }
  let pid = listenerPid(options.port);
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const env = processEnvText(pid);
    const cloud = envValue(env, "CONVEX_LOCAL_CLOUD_PORT");
    const site = envValue(env, "CONVEX_LOCAL_SITE_PORT");
    if (cloud || site) {
      return {
        ...options,
        cloudPort: options.cloudPortSet
          ? options.cloudPort
          : (cloud ?? options.cloudPort),
        sitePort: options.sitePortSet
          ? options.sitePort
          : (site ?? options.sitePort),
      };
    }
    pid = parentPid(pid);
    if (pid === "0" || pid === "1") break;
  }
  return options;
}

/**
 * Las empresas de esta corrida, en orden, con el perfil y los documentos que el
 * seed les pone.
 *
 * El dueño sale del slug del nombre, la misma regla que `seed:company`. Una
 * empresa nombrada con `--company` que esté en el portfolio se mide con SU
 * perfil del plan: así el seed converge en vez de pelearse con lo que
 * `seed:portfolio` ya dejó sembrado.
 */
export function buildCompanyRuns(options) {
  if (options.portfolio !== null)
    return buildPortfolioSeedPlan(options.portfolio);
  const name = options.company ?? COMPANY_NAME;
  const planned = buildPortfolioSeedPlan(MAX_SEED_PORTFOLIO_COMPANIES).find(
    (row) => row.name === name,
  );
  if (planned) return [planned];
  const slug = slugifyCompanyName(name);
  return [
    {
      name,
      slug,
      ownerEmail: `${slug}@dev.local`,
      profile: DEFAULT_COMPANY_PROFILE,
      // Journeys necesita un PDF extraíble para J5 (`Legales 1.pdf`). El resto
      // de empresas nuevas se siembran vacías, igual que antes.
      documents: name === COMPANY_NAME ? 1 : 0,
    },
  ];
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function respondsOk(url) {
  try {
    const response = await fetch(url, { redirect: "manual" });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

/** Espera a que la app conteste, o se rinde con el log a mano. */
async function waitForApp(base, logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await respondsOk(`${base}/es`)) return true;
    await sleep(1000);
  }
  console.error(`\nLa app no contestó en ${base}/es. Revisa ${logFile}.`);
  return false;
}

/** El env del banco local, tal como lo resuelve `convex-local.mjs env`. */
function localEnv(ports) {
  const result = spawnSync(process.execPath, [CONVEX_LOCAL, "env"], {
    cwd: APP_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      CONVEX_LOCAL_CLOUD_PORT: ports.cloudPort,
      CONVEX_LOCAL_SITE_PORT: ports.sitePort,
      PORT: ports.port,
    },
  });
  if (result.status !== 0) {
    console.error(result.stderr || "No se pudo leer el env del backend local.");
    process.exit(result.status ?? 1);
  }
  const env = {};
  for (const line of result.stdout.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

function runConvexLocal(args, ports) {
  return spawnSync(process.execPath, [CONVEX_LOCAL, ...args], {
    cwd: APP_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      CONVEX_LOCAL_CLOUD_PORT: ports.cloudPort,
      CONVEX_LOCAL_SITE_PORT: ports.sitePort,
      PORT: ports.port,
    },
  });
}

/**
 * Deja que la app se asiente después del seed.
 *
 * `convex-local.mjs seed` reescribe `convex.json` y `package.json` en el
 * sandbox y el `convex dev` que mira esa carpeta vuelve a empaquetar. Durante
 * ese rato el HTML que `next dev` está transmitiendo se puede cortar a medias
 * («The destination stream closed early» del lado servidor, «Invalid or
 * unexpected token» del lado navegador) y esa pestaña no hidrata nunca.
 * Medido el 2026-09-12: pasa en la primera pantalla que se cargue en los
 * segundos siguientes al seed, y no vuelve a pasar después.
 *
 * La señal es el HTML entero: una respuesta cortada no termina en `</html>`.
 * Tres completas seguidas y la app está sirviendo de verdad.
 */
async function servesCompleteHtml(base) {
  try {
    const response = await fetch(`${base}/es`, { cache: "no-store" });
    if (!response.ok) return false;
    return (await response.text()).trimEnd().endsWith("</html>");
  } catch {
    return false;
  }
}

/**
 * Espera a que el banco quede quieto.
 *
 * Cada llamada a `convex-local.mjs` reescribe `.convex-local/convex.json`, y el
 * `convex dev` que mira esa carpeta vuelve a empaquetar unos segundos después.
 * Un push con los journeys ya corriendo deja a `next dev` sirviendo chunks y
 * manifiestos a medias: medido el 2026-09-12, J1 se llevó un 500 en
 * `/api/intake/uploads` y J4 se quedó con el overlay de error de Next delante
 * del formulario del invitado. El disparador es ese archivo, así que cuando
 * lleva `SANDBOX_QUIET_MS` sin cambiar, el empaquetado que provocó ya terminó.
 */
async function waitForSandboxQuiet() {
  const trigger = path.join(APP_DIR, ".convex-local", "convex.json");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (!existsSync(trigger)) return;
    const age = Date.now() - statSync(trigger).mtimeMs;
    if (age >= SANDBOX_QUIET_MS) return;
    await sleep(Math.min(1000, SANDBOX_QUIET_MS - age));
  }
}

async function settle(base) {
  await waitForSandboxQuiet();
  const deadline = Date.now() + 120_000;
  let good = 0;
  while (Date.now() < deadline) {
    good = (await servesCompleteHtml(base)) ? good + 1 : 0;
    if (good >= 3) return true;
    await sleep(1000);
  }
  return false;
}

// Las pantallas de la sala y del equipo piden sesión: sin cookie el proxy
// redirige y la pantalla no se compila. Se piden con los dos usuarios fijos de
// `DEV_USERS`, porque `next dev` compila por ruta y no por usuario.
const WARM_SESSION = {
  COMPANY: "sherlock_dev_user=dev_company_001; sherlock_dev_role=COMPANY",
  ADMIN: "sherlock_dev_user=dev_admin_001; sherlock_dev_role=ADMIN",
};
const WARM_PAGES = [
  ["/es", null],
  ["/es/dev-login", null],
  ["/es/onboarding", "COMPANY"],
  ["/es/vdr-guest", null],
  ["/es/my-company/documents", "COMPANY"],
  ["/es/my-company/preparation", "COMPANY"],
  ["/es/my-company/company", "COMPANY"],
  ["/es/admin", "ADMIN"],
  ["/es/admin/companies", "ADMIN"],
];
const WARM_ROUTES = [
  "/api/intake/session",
  "/api/intake/uploads",
  "/api/intake/uploads/register",
  "/api/intake/claim",
  "/api/upload",
  "/api/documents/upload",
  "/api/analytics/journey",
  "/api/vdr/guest/session",
  "/api/vdr/guest/otp/request",
  "/api/vdr/guest/verify",
  "/api/vdr/guest/room",
  "/api/vdr/guest/nda",
  "/api/vdr-mcp",
];

/**
 * Compila las pantallas y rutas de los cinco journeys antes de cronometrar.
 *
 * `next dev` compila bajo demanda. La primera llamada a una ruta que todavía
 * no existe se cae con «Manifest file is empty» (500), y mientras compila, la
 * pantalla que esté cargando se queda con un chunk truncado que no hidrata.
 * Medido el 2026-09-12: el primer `POST /api/vdr/guest/verify` compiló en
 * medio de J4 y la pestaña del invitado quedó en «Estamos comprobando tu sesión
 * segura» sin volver. Las rutas de API se compilan con cualquier método; la
 * respuesta (403, 405) no importa.
 */
export async function warm(base) {
  for (const [route, role] of WARM_PAGES) {
    try {
      const response = await fetch(`${base}${route}`, {
        redirect: "manual",
        headers: role ? { cookie: WARM_SESSION[role] } : {},
      });
      await response.text();
    } catch {
      // Un fallo de red aquí no dice nada: el objetivo era compilar la ruta.
    }
  }
  for (const route of WARM_ROUTES) {
    // GET y POST, con cabeceras de mismo origen: el proxy rechaza un POST sin
    // `content-type` ni `origin` antes de que la ruta llegue a compilar (403 en
    // 6 ms, medido el 2026-09-12), y entonces el primer POST de verdad compila
    // en medio del journey. La respuesta que devuelvan aquí (401, 403, 405) da
    // igual: lo que importa es que el módulo quede armado.
    for (const method of ["GET", "POST"]) {
      try {
        const response = await fetch(`${base}${route}`, {
          method,
          headers: {
            "content-type": "application/json",
            origin: base,
            // Sin sesión el proxy rechaza las APIs protegidas antes de compilarlas.
            cookie: WARM_SESSION.COMPANY,
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        await response.text();
      } catch {
        // Igual que arriba.
      }
    }
  }
}

/**
 * La llave de Resend del banco local.
 *
 * `inviteToCompany` se niega a invitar sin `RESEND_API_KEY`
 * (`convex/_guests/capabilities.ts`) y `dev:local` no la fija. Con
 * `RESEND_TEST_MODE` el componente solo acepta destinatarios `*@resend.dev` y
 * guarda el correo entero en sus tablas antes de enviarlo: J4 lee de ahí la
 * invitación y el OTP. La llave es de relleno, así que Resend rechaza el envío
 * con 401 y ningún correo sale de la Mac.
 */
export const LOCAL_RESEND_KEY = "re_banco_local_journeys";

const ANONYMOUS_CONVEX_ENV = {
  CONVEX_AGENT_MODE: "anonymous",
  CONVEX_DEPLOYMENT: "anonymous:anonymous-agent",
  CONVEX_DEPLOY_KEY: "",
  CONVEX_SELF_HOSTED_URL: "",
  CONVEX_SELF_HOSTED_ADMIN_KEY: "",
};

function convexAnonymousEnv() {
  return { ...process.env, ...ANONYMOUS_CONVEX_ENV };
}

function parseResendEnvGet(stdout) {
  const text = (stdout ?? "").trim();
  if (text.startsWith("RESEND_API_KEY="))
    return text.slice("RESEND_API_KEY=".length);
  return text;
}

/**
 * Fija la llave de Resend del banco solo si el valor actual es otro.
 *
 * `convex env set` reescribe el sandbox y `convex dev` vuelve a empaquetar;
 * J4 se quedaba con un chunk truncado. Si la llave ya está, no se toca.
 */
export function ensureLocalResendKey(run = spawnSync) {
  const convexBin = [
    path.join(APP_DIR, "node_modules", ".bin", "convex"),
    path.join(ROOT, "node_modules", ".bin", "convex"),
  ].find((candidate) => existsSync(candidate));
  if (!convexBin) {
    console.error(
      "No encuentro el CLI de Convex. Corre `bun install` primero.",
    );
    process.exit(1);
  }
  const cwd = path.join(APP_DIR, ".convex-local");
  const env = convexAnonymousEnv();
  const got = run(convexBin, ["env", "get", "RESEND_API_KEY"], {
    cwd,
    encoding: "utf8",
    env,
  });
  const current = parseResendEnvGet(got.status === 0 ? got.stdout : "");
  if (current === LOCAL_RESEND_KEY) return;
  const result = run(
    convexBin,
    ["env", "set", "RESEND_API_KEY", LOCAL_RESEND_KEY],
    {
      cwd,
      stdio: "inherit",
      env,
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/**
 * Las empresas del banco. Idempotente: lo que ya está no se duplica.
 *
 * Un solo banco para todas: `seed:portfolio` siembra las N de un tirón y las
 * diez salas conviven. Todo esto pasa antes de asentar y calentar, porque cada
 * llamada reescribe el sandbox y `convex dev` vuelve a empaquetar.
 */
function seed(ports, options, runs) {
  const seeded = runConvexLocal(["seed"], ports);
  if (seeded.status !== 0) process.exit(seeded.status ?? 1);
  if (options.portfolio !== null) {
    const portfolio = runConvexLocal(
      ["seed:portfolio", "--n", `${options.portfolio}`],
      ports,
    );
    if (portfolio.status !== 0) process.exit(portfolio.status ?? 1);
  } else {
    const [company] = runs;
    const one = runConvexLocal(
      [
        "seed:company",
        "--name",
        company.name,
        "--docs",
        `${company.documents}`,
        "--perfil",
        company.profile,
      ],
      ports,
    );
    if (one.status !== 0) process.exit(one.status ?? 1);
  }
  ensureLocalResendKey();
}

function startDevLocal(ports, logFile) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  writeFileSync(logFile, "");
  const log = openSync(logFile, "a");
  // Líder de su propio grupo: el backend Convex es nieto de este proceso y solo
  // se lo lleva un SIGTERM al grupo entero.
  //
  // Se arranca el script de Convex directamente en vez de `bun run dev:local`:
  // esa ruta mete dos envoltorios de bun entre este proceso y el backend, y en
  // esta Mac algo barre los árboles cuya línea de comando dice «dev:local».
  // Medido el 2026-09-12: con el envoltorio, un banco ocioso murió con SIGTERM
  // a los 60 s; arrancado así aguantó los 4 min de la prueba sin una señal.
  return spawn(process.execPath, [CONVEX_LOCAL, "dev"], {
    cwd: APP_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      PORT: ports.port,
      CONVEX_LOCAL_CLOUD_PORT: ports.cloudPort,
      CONVEX_LOCAL_SITE_PORT: ports.sitePort,
    },
  });
}

function stopDevLocal(child, ports) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  // El backend es hijo del CLI de Convex y el SIGTERM es asíncrono: quien venga
  // después necesita los puertos libres, no la promesa de que van a estarlo.
  spawnSync("bash", [
    "-c",
    `lsof -ti tcp:${ports.port},${ports.cloudPort},${ports.sitePort} | xargs kill 2>/dev/null || true`,
  ]);
}

function readRows(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeTsv(rows, startedAt) {
  mkdirSync(JOURNEYS_DIR, { recursive: true });
  const started = new Date(startedAt);
  const pad = (value) => `${value}`.padStart(2, "0");
  // Fecha y hora locales: la tabla la lee un humano en su huso, no en UTC.
  const stamp =
    `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}` +
    `-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
  const file = path.join(JOURNEYS_DIR, `${stamp}.tsv`);
  const lines = ["empresa\tjourney\tpaso\tms\tok\terrores_consola\trecargas"];
  for (const row of rows) {
    lines.push(
      `${row.empresa}\t${row.journey}\t${row.paso}\t${row.ms}\t${row.ok ? "si" : "no"}\t${row.errores_consola}\t${row.recargas ?? 0}`,
    );
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/**
 * La tabla por empresa: una fila por sala medida.
 *
 * Cada celda de journey trae los ms de su fila `total`, `rojo` si el journey
 * corrió y se cayó, y `-` si no corrió (por ejemplo con `--journey j2`). El
 * total de la fila suma solo los journeys verdes: sumar un rojo sería inventar
 * el tiempo que no tuvo.
 */
export function buildCompanyTable(rows, runs) {
  return runs.map((company) => {
    const mine = rows.filter((row) => row.empresa === company.name);
    const cells = [];
    const red = [];
    const overGoal = [];
    let total = 0;
    for (const id of Object.keys(GOALS)) {
      const journeyRows = mine.filter((row) => row.journey === id);
      if (journeyRows.length === 0) {
        cells.push("-");
        continue;
      }
      const totalRow = journeyRows.find((row) => row.paso === "total");
      if (!totalRow || journeyRows.some((row) => !row.ok)) {
        cells.push("rojo");
        red.push(id);
        continue;
      }
      cells.push(`${totalRow.ms}`);
      total += totalRow.ms;
      if (totalRow.ms > GOALS[id])
        overGoal.push(`${id} ${totalRow.ms} > ${GOALS[id]}`);
    }
    return { company, cells, total, red, overGoal };
  });
}

function summarize(rows, runs) {
  const table = buildCompanyTable(rows, runs);
  console.log("\nempresa\tperfil\tJ1\tJ2\tJ3\tJ4\tJ5\ttotal_ms\trojo");
  for (const line of table) {
    console.log(
      `${line.company.name}\t${line.company.profile}\t${line.cells.join("\t")}` +
        `\t${line.total}\t${line.red.length > 0 ? line.red.join(" ") : "no"}`,
    );
  }
  let allWithinGoal = true;
  for (const line of table) {
    for (const over of line.overGoal) {
      allWithinGoal = false;
      console.log(`Sobre la meta: ${line.company.name} · ${over}`);
    }
  }
  const failed = rows.filter((row) => !row.ok);
  for (const row of failed) {
    console.log(`\nPaso rojo: ${row.empresa} · ${row.journey} · ${row.paso}`);
  }
  for (const row of rows) {
    if (row.paso === "total" && row.mensajes.length > 0) {
      console.log(`\nErrores de consola en ${row.empresa} · ${row.journey}:`);
      for (const message of row.mensajes) console.log(`  ${message}`);
    }
  }
  return { allWithinGoal, redSteps: failed.length };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  options = inheritLiveBackendPorts(options);

  const startedAt = Date.now();
  const ports = {
    port: options.port,
    cloudPort: options.cloudPort,
    sitePort: options.sitePort,
  };
  const base = options.base ?? `http://localhost:${ports.port}`;
  if (options.base) {
    console.log(
      `Reusando ${base} (backend ${ports.cloudPort}/${ports.sitePort}).`,
    );
  }
  // Los dos archivos de trabajo viven FUERA del árbol del proyecto: cada línea
  // escrita adentro despierta al watcher de `next dev`, y una pantalla que se
  // esté cargando en ese momento se queda con el HTML cortado y no hidrata.
  const logFile = path.join(JOURNEYS_DIR, `.dev-${ports.port}.log`);
  const stepLog = path.join(JOURNEYS_DIR, `.pasos-${ports.port}.jsonl`);
  mkdirSync(JOURNEYS_DIR, { recursive: true });
  rmSync(stepLog, { force: true });

  let devLocal = null;
  if (!options.base) {
    if (await respondsOk(`${base}/es`)) {
      console.log(`Ya hay algo escuchando en ${base}: se reusa.`);
    } else {
      console.log(
        `Levantando dev:local en ${base} (backend ${ports.cloudPort}/${ports.sitePort})…`,
      );
      mkdirSync(path.dirname(logFile), { recursive: true });
      devLocal = startDevLocal(ports, logFile);
      if (!(await waitForApp(base, logFile, 5 * 60_000))) {
        stopDevLocal(devLocal, ports);
        process.exit(1);
      }
    }
  } else if (!(await respondsOk(`${base}/es`))) {
    console.error(`No hay nada escuchando en ${base}/es.`);
    process.exit(1);
  }

  // Todo lo que llama a `convex-local.mjs` va antes de asentar y calentar: cada
  // llamada reescribe el sandbox `.convex-local/` y `convex dev` vuelve a
  // empaquetar. Medido el 2026-09-12: el `env` que antes se leía justo antes de
  // Playwright disparaba un push con J1 ya cargando la landing.
  const benchEnv = localEnv(ports);
  const runs = buildCompanyRuns(options);
  console.log(
    `Sembrando el banco (${runs.length === 1 ? `"${runs[0].name}"` : `${runs.length} empresas`})…`,
  );
  seed(ports, options, runs);
  if (!(await settle(base))) {
    console.error(`La app dejó de contestar en ${base}/es después del seed.`);
    stopDevLocal(devLocal, ports);
    process.exit(1);
  }
  await warm(base);

  const specs = options.journeys.map((key) => JOURNEY_SPECS[key]);
  let redRuns = 0;
  for (const [index, company] of runs.entries()) {
    console.log(
      `\n[${index + 1}/${runs.length}] ${company.name} · perfil ${company.profile} · ${company.ownerEmail}`,
    );
    // El banco es uno para todas y nadie lo reinicia entre empresas, pero J5
    // escribe en el sandbox la primera vez que firma un token: asentar antes de
    // cada empresa cuesta tres segundos y ahorra el chunk truncado.
    if (index > 0 && !(await settle(base))) {
      console.error(
        `La app dejó de contestar en ${base}/es. Sigue la corrida.`,
      );
    }
    const playwright = spawnSync(
      "bunx",
      [
        "playwright",
        "test",
        ...specs,
        "--project=chromium",
        "--workers=1",
        "--reporter=line",
      ],
      {
        cwd: APP_DIR,
        stdio: "inherit",
        env: {
          ...process.env,
          ...benchEnv,
          JOURNEYS_LOG: stepLog,
          JOURNEYS_RUN_ID: `${startedAt}`,
          // La misma lista que `--journey`: J3 exige un pull fresco si J1 o
          // J2 corrieron en esta ejecución.
          JOURNEYS: options.journeys.join(","),
          // La empresa de esta vuelta y su dueño, que el helper de los specs
          // lee de aquí (`benchCompany` en `e2e/helpers/journeys.ts`).
          JOURNEYS_COMPANY: company.name,
          JOURNEYS_OWNER_EMAIL: company.ownerEmail,
          PLAYWRIGHT_REUSE_SERVER: "true",
          E2E_BASE_URL: base,
          // El config de Playwright apunta `NEXT_PUBLIC_CONVEX_URL` a un
          // placeholder en modo demo salvo con esta bandera; los journeys corren
          // contra el backend local sembrado.
          E2E_DEV_AUTH_USE_SEEDED_CONVEX: "true",
          BYPASS_AUTH: "true",
          NEXT_PUBLIC_BYPASS_AUTH: "true",
          NEXT_PUBLIC_DEV_AUTH_ENABLED: "true",
        },
      },
    );
    // Un journey rojo en una empresa no detiene a las demás (tarjeta O5-01):
    // queda `rojo` en su fila de la tabla y la corrida sigue con la siguiente.
    if (playwright.status !== 0) redRuns += 1;
  }

  const rows = readRows(stepLog);
  const tsv = writeTsv(rows, startedAt);
  const { allWithinGoal, redSteps } = summarize(rows, runs);
  console.log(`\nTabla: ${tsv}`);
  console.log(
    `Total de la corrida: ${Math.round((Date.now() - startedAt) / 1000)} s`,
  );

  if (!options.keep) stopDevLocal(devLocal, ports);
  else if (devLocal) console.log(`dev:local sigue vivo en ${base} (--keep).`);

  if (redRuns > 0 || redSteps > 0) process.exit(1);
  if (!allWithinGoal) {
    console.log(
      "\nAlgún journey pasó su meta: verde en pasos, lento en tiempo.",
    );
  }
}

// Importable sin correr: los tests del parseo cargan este módulo.
const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.filename === path.resolve(process.argv[1]);

if (isDirectRun) await main();
