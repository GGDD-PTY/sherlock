#!/usr/bin/env bun

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { e2ePortEnvironment, pickE2EPort } from "./verify-local-e2e-port.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const RECEIPTS_DIR = path.join(
  homedir(),
  "Developer",
  "sherlock-handoffs",
  "verify-receipts",
);
const rootPackage = JSON.parse(
  await readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
);
const packageManagerMatch = /^bun@(\d+\.\d+\.\d+)$/.exec(
  rootPackage.packageManager ?? "",
);
if (!packageManagerMatch)
  throw new Error("package.json must pin packageManager as bun@x.y.z");
const REQUIRED_BUN_VERSION = packageManagerMatch[1];
const REQUIRED_NODE_VERSION = (
  await readFile(path.join(REPO_ROOT, "sherlock/app/.nvmrc"), "utf8")
).trim();
parseVersion(REQUIRED_NODE_VERSION);
const INVOCATION = "mise x -- bun run verify:local";

const baseEnvironment = {
  ...process.env,
  SHERLOCK_WITH_MISE_NODE: "1",
};
let sharedEnvironment = baseEnvironment;

// `E2E_PORT` y `NEXT_PUBLIC_WORKOS_REDIRECT_URI` salen del puerto elegido en
// tiempo de corrida (`verify-local-e2e-port.mjs`), no de una constante.
const e2eEnvironment = {
  NEXT_PUBLIC_CONVEX_URL: "https://placeholder.convex.cloud",
  WORKOS_API_KEY: "workos_api_key_for_ci",
  WORKOS_CLIENT_ID: "client_test_ci",
  WORKOS_COOKIE_PASSWORD: "replace_with_32_plus_characters_for_ci", // gitleaks:allow -- deterministic test fixture, not a provider credential
  WORKOS_WEBHOOK_SECRET: "workos_webhook_secret_for_ci",
  CONVEX_DEPLOY_KEY: "placeholder_deploy_key",
  WEBHOOK_SECRET: "placeholder_webhook_secret",
  CONVEX_DEPLOYMENT: "placeholder",
  STORAGE_SECRET: "placeholder_storage_secret",
  ADMIN_VDR_CAPABILITY_SECRET: "placeholder_admin_vdr_capability_secret_for_ci",
  NEXT_PUBLIC_DEV_AUTH_ENABLED: "true",
  NEXT_PUBLIC_BYPASS_AUTH: "true",
  BYPASS_AUTH: "true",
  E2E_SERVER_MODE: "dev",
};

const steps = [
  {
    name: "assert pinned runtimes",
    display: `assert Bun ${REQUIRED_BUN_VERSION} and Node ${REQUIRED_NODE_VERSION}`,
    runtimeAssertion: true,
  },
  {
    name: "frozen dependency install",
    command: ["bun", "install", "--frozen-lockfile"],
  },
  {
    name: "typecheck",
    command: ["bun", "--cwd=sherlock/app", "run", "typecheck:all"],
  },
  {
    name: "lint",
    command: ["bun", "--cwd=sherlock/app", "run", "lint"],
  },
  {
    name: "dead code",
    command: ["bun", "--cwd=sherlock/app", "run", "dead-code"],
  },
  {
    name: "north-star fitness",
    command: ["bun", "--cwd=sherlock/app", "run", "fitness:north-star"],
  },
  {
    name: "beta environment",
    command: ["bun", "--cwd=sherlock/app", "run", "beta:env:check"],
  },
  {
    name: "security reachability",
    command: ["bun", "--cwd=sherlock/app", "run", "security:audit:reachable"],
    environment: {
      SECURITY_REACHABILITY_MATRIX_OUT: "/private/tmp/sherlock-reachability.md",
    },
  },
  {
    name: "coverage",
    command: ["bun", "--cwd=sherlock/app", "run", "test:coverage"],
  },
  {
    name: "production build",
    command: ["bun", "--cwd=sherlock/app", "run", "build"],
  },
  {
    name: "bundle size",
    command: [
      "bun",
      "--cwd=sherlock/app",
      "run",
      "scripts/bundle-size-check.ts",
    ],
  },
  {
    name: "e2e smoke",
    command: [
      "bun",
      "--cwd=sherlock/app",
      "run",
      "test:e2e:smoke",
      "--",
      "--project=chromium",
      "--workers=1",
    ],
    environment: e2eEnvironment,
    needsE2EPort: true,
  },
  {
    name: "e2e journeys",
    command: [
      "bun",
      "--cwd=sherlock/app",
      "run",
      "test:e2e:journeys",
      "--",
      "--project=chromium",
      "--workers=1",
    ],
    environment: e2eEnvironment,
    needsE2EPort: true,
  },
];

function renderCommand(command) {
  return command
    .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
    .join(" ");
}

function parseVersion(version) {
  const match = version
    .trim()
    .replace(/^v/, "")
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(`Could not parse runtime version: ${version}`);
  }

  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

async function capture(command) {
  const process = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: sharedEnvironment,
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(process.stdout).text();
  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`${renderCommand(command)} exited with code ${exitCode}`);
  }

  return output.trim();
}

async function assertRuntimes() {
  const nodeInstall = await capture([
    "mise",
    "where",
    `node@${REQUIRED_NODE_VERSION}`,
  ]);
  sharedEnvironment = {
    ...baseEnvironment,
    PATH: [
      path.dirname(process.execPath),
      path.join(nodeInstall, "bin"),
      baseEnvironment.PATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const nodeVersion = await capture(["node", "--version"]);
  const parsedNodeVersion = parseVersion(nodeVersion);
  const validNodeVersion =
    compareVersions(parsedNodeVersion, parseVersion(REQUIRED_NODE_VERSION)) ===
    0;

  if (Bun.version !== REQUIRED_BUN_VERSION || !validNodeVersion) {
    throw new Error(
      [
        `verify:local requires Bun ${REQUIRED_BUN_VERSION} and Node ${REQUIRED_NODE_VERSION}.`,
        `Active runtimes: Bun ${Bun.version}, Node ${nodeVersion.replace(/^v/, "")}.`,
        `Run: ${INVOCATION}`,
      ].join("\n"),
    );
  }

  return {
    bun: Bun.version,
    bunPath: process.execPath,
    node: nodeVersion.replace(/^v/, ""),
    nodePath: Bun.which("node"),
  };
}

async function runCommand(command, environment = {}) {
  const process = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: { ...sharedEnvironment, ...environment },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return process.exited;
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(2)}s`;
}

function printResults(results) {
  console.log("\nverify:local timings");
  for (const result of results) {
    console.log(
      `${String(result.index).padStart(2, "0")}. ${result.status.padEnd(4)} ${formatDuration(result.durationMs).padStart(9)}  ${result.name}`,
    );
  }
}

function receiptTimestamp(isoTimestamp) {
  return isoTimestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function writeReceipt(receipt) {
  await mkdir(RECEIPTS_DIR, { recursive: true });
  const shortSha = receipt.gitSha.slice(0, 12);
  const filename = `verify-local-${receiptTimestamp(receipt.finishedAt)}-${shortSha}.json`;
  const destination = path.join(RECEIPTS_DIR, filename);
  const temporary = `${destination}.tmp-${process.pid}`;

  await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return destination;
}

async function main() {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const gitSha = await capture(["git", "rev-parse", "HEAD"]);
  const results = [];
  let runtimes;
  let e2ePort = null;

  console.log(`verify:local ${gitSha}`);

  for (const [offset, step] of steps.entries()) {
    const index = offset + 1;
    const stepStarted = performance.now();
    const command = step.runtimeAssertion
      ? step.display
      : renderCommand(step.command);

    console.log(`\n[${index}/${steps.length}] ${step.name}`);
    console.log(command);

    try {
      if (step.runtimeAssertion) {
        runtimes = await assertRuntimes();
      } else {
        let environment = step.environment;
        if (step.needsE2EPort) {
          e2ePort ??= await pickE2EPort();
          console.log(`E2E port: ${e2ePort}`);
          environment = { ...environment, ...e2ePortEnvironment(e2ePort) };
        }
        const exitCode = await runCommand(step.command, environment);
        if (exitCode !== 0) {
          throw new Error(`${command} exited with code ${exitCode}`);
        }
      }

      results.push({
        index,
        name: step.name,
        command,
        status: "pass",
        durationMs: Math.round(performance.now() - stepStarted),
      });
    } catch (error) {
      results.push({
        index,
        name: step.name,
        command,
        status: "fail",
        durationMs: Math.round(performance.now() - stepStarted),
      });
      printResults(results);
      throw error;
    }
  }

  const finishedGitSha = await capture(["git", "rev-parse", "HEAD"]);
  if (finishedGitSha !== gitSha) {
    throw new Error(
      `HEAD changed during verify:local: ${gitSha} -> ${finishedGitSha}`,
    );
  }

  const finishedAt = new Date().toISOString();
  const receipt = {
    schemaVersion: 1,
    status: "pass",
    startedAt,
    finishedAt,
    gitSha,
    runtimes,
    totalDurationMs: Math.round(performance.now() - started),
    steps: results,
  };
  const receiptPath = await writeReceipt(receipt);

  printResults(results);
  console.log(`\nPASS ${formatDuration(receipt.totalDurationMs)} ${gitSha}`);
  console.log(`Receipt: ${receiptPath}`);
}

try {
  await main();
} catch (error) {
  console.error(
    `\nverify:local failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
