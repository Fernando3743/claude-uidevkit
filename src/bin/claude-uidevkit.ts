#!/usr/bin/env node

// claude-uidevkit CLI — `npx claude-uidevkit init` wires a Next.js App Router project
// up in one shot: scaffolds the API route, installs the /uidevkit slash
// command, adds the .gitignore entry, installs deps, and prints the layout mount
// snippet. Zero runtime dependencies — Node built-ins only.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));

// Templates ship at the package root (`templates/`); the built CLI may live at
// `dist/cli.js` or `dist/bin/…`, so walk up until we find them rather than assume
// a fixed depth.
function resolveTemplatesDir(): string {
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "templates");
    if (existsSync(join(candidate, "route.ts.tmpl"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(HERE, "..", "templates");
}
const TEMPLATES = resolveTemplatesDir();

// ── tiny ANSI helpers ────────────────────────────────────────────────────────
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `${code}${s}\x1b[0m` : s);
const bold = wrap("\x1b[1m");
const dim = wrap("\x1b[2m");
const green = wrap("\x1b[32m");
const yellow = wrap("\x1b[33m");
const cyan = wrap("\x1b[36m");
const red = wrap("\x1b[31m");

const ok = (s: string) => console.log(`  ${green("✔")} ${s}`);
const skip = (s: string) => console.log(`  ${yellow("•")} ${s}`);
const fail = (s: string) => console.log(`  ${red("✘")} ${s}`);
const note = (s: string) => console.log(`  ${dim(s)}`);

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

function detectPackageManager(root: string): PackageManager {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

function installCommand(pm: PackageManager, deps: string[]): string {
  const list = deps.join(" ");
  switch (pm) {
    case "pnpm":
      return `pnpm add -D ${list}`;
    case "yarn":
      return `yarn add -D ${list}`;
    case "bun":
      return `bun add -d ${list}`;
    default:
      return `npm install -D ${list}`;
  }
}

function detectAppDir(root: string): { abs: string; rel: string; created: boolean } {
  if (existsSync(join(root, "src", "app"))) return { abs: join(root, "src", "app"), rel: "src/app", created: false };
  if (existsSync(join(root, "app"))) return { abs: join(root, "app"), rel: "app", created: false };
  // Fall back to `app/` at the root and create it.
  return { abs: join(root, "app"), rel: "app", created: true };
}

function findLayout(appAbs: string, appRel: string): string | null {
  for (const ext of ["tsx", "jsx", "js"]) {
    if (existsSync(join(appAbs, `layout.${ext}`))) return `${appRel}/layout.${ext}`;
  }
  return null;
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function printHelp() {
  console.log(`
${bold("claude-uidevkit")} — in-app "click → fix with Claude" overlay for Next.js

${bold("Usage")}
  npx claude-uidevkit init [options]

${bold("Options")}
  --force        Overwrite an existing route file / slash command
  --no-install   Don't install deps; print the command to run instead
  -h, --help     Show this help

${bold("What init does")}
  • creates <app>/api/claude-uidevkit/route.ts   (re-exports the capture handler)
  • adds .claude/commands/uidevkit.md             (the /uidevkit command)
  • appends .claude/claude-uidevkit/ to .gitignore
  • installs claude-uidevkit + html-to-image as devDependencies
  • prints the one-line <ClaudeUIDevkit/> mount to add to your layout
`);
}

function runInit() {
  const root = process.cwd();
  const argv = process.argv.slice(2);
  const force = argv.includes("--force");
  const noInstall = argv.includes("--no-install");

  console.log(`\n${bold(cyan("claude-uidevkit"))} ${dim("· wiring up this project")}\n`);

  if (!existsSync(join(root, "package.json"))) {
    fail(`No package.json found in ${root}.`);
    note("Run this from the root of your Next.js project.");
    process.exitCode = 1;
    return;
  }

  const isTS = existsSync(join(root, "tsconfig.json"));
  const ext = isTS ? "ts" : "js";
  const app = detectAppDir(root);
  if (app.created) {
    note(`No app/ or src/app/ found — assuming ${app.rel}/ (App Router).`);
  }

  // 1. API route ───────────────────────────────────────────────────────────────
  const routeDir = join(app.abs, "api", "claude-uidevkit");
  const routeFile = join(routeDir, `route.${ext}`);
  if (existsSync(routeFile) && !force) {
    skip(`route exists, left as-is: ${relative(root, routeFile)} ${dim("(--force to overwrite)")}`);
  } else {
    ensureDir(routeDir);
    writeFileSync(routeFile, readFileSync(join(TEMPLATES, "route.ts.tmpl"), "utf8"));
    ok(`route: ${relative(root, routeFile)}`);
  }

  // 2. Slash command ─────────────────────────────────────────────────────────────
  const commandsDir = join(root, ".claude", "commands");
  const commandFile = join(commandsDir, "uidevkit.md");
  if (existsSync(commandFile) && !force) {
    skip(`slash command exists, left as-is: ${relative(root, commandFile)} ${dim("(--force to overwrite)")}`);
  } else {
    ensureDir(commandsDir);
    copyFileSync(join(TEMPLATES, "uidevkit.md"), commandFile);
    ok(`slash command: ${relative(root, commandFile)} ${dim("(run /uidevkit)")}`);
  }

  // 3. .gitignore ────────────────────────────────────────────────────────────────
  const gitignore = join(root, ".gitignore");
  const entry = ".claude/claude-uidevkit/";
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (existing.split(/\r?\n/).some((l) => l.trim() === entry)) {
    skip(`.gitignore already ignores ${entry}`);
  } else {
    const prefix = existing.length && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(
      gitignore,
      `${existing}${prefix}\n# claude-uidevkit capture queue (local, regenerable)\n${entry}\n`,
    );
    ok(`.gitignore: ignored ${entry}`);
  }

  // 4. Dependencies ──────────────────────────────────────────────────────────────
  const pm = detectPackageManager(root);
  const deps = ["claude-uidevkit", "html-to-image"];
  const cmd = installCommand(pm, deps);
  if (noInstall) {
    skip(`skipped install — run it yourself:`);
    note(`  ${cmd}`);
  } else {
    console.log(`  ${green("✔")} installing deps ${dim(`(${pm})`)}…`);
    try {
      execSync(cmd, { stdio: "inherit", cwd: root });
      ok(`installed: ${deps.join(", ")}`);
    } catch {
      fail(`install failed — run it yourself:`);
      note(`  ${cmd}`);
    }
  }

  // 5. Layout mount snippet (printed — not auto-edited) ───────────────────────────
  const layout = findLayout(app.abs, app.rel);
  console.log(`\n${bold("One step left")} — mount the overlay in your root layout`);
  if (layout) {
    note(`Edit ${layout}:`);
  } else {
    note(`Edit your root layout (${app.rel}/layout.${ext}):`);
  }
  console.log(
    cyan(`
  import { ClaudeUIDevkit } from "claude-uidevkit";

  // …then, inside <body>:
  {process.env.NODE_ENV !== "production" && <ClaudeUIDevkit />}
`),
  );

  // Summary ───────────────────────────────────────────────────────────────────────
  console.log(`${bold(green("Done."))} Next:`);
  note(`1. add the mount line above to your layout`);
  note(`2. start your dev server, then click 🐛 Element / ⬚ Area (bottom-right)`);
  note(`3. type what to change → Send → run ${cyan("/uidevkit")} in Claude Code`);
  console.log("");
}

const first = process.argv[2];
if (first === "init") {
  runInit();
} else if (!first || first === "-h" || first === "--help" || first === "help") {
  printHelp();
} else {
  console.log(`Unknown command: ${first}\n`);
  printHelp();
  process.exitCode = 1;
}
