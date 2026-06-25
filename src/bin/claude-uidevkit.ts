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
  // Neither app dir exists yet — pick where to create one. If the project keeps
  // its source under `src/` (the Next.js `src/` convention), scaffold `src/app`
  // so the route lands next to the rest of the code; otherwise fall back to a
  // root `app/`.
  if (existsSync(join(root, "src")))
    return { abs: join(root, "src", "app"), rel: "src/app", created: true };
  return { abs: join(root, "app"), rel: "app", created: true };
}

// Heuristic: does this look like a Pages-Router-only project? True when a
// `pages/` (or `src/pages/`) directory exists but no App Router dir does.
// claude-uidevkit scaffolds App-Router-only artifacts (a `route.ts`), so we want
// to warn loudly rather than silently drop them into a Pages-Router project.
function isPagesRouterOnly(root: string): boolean {
  const hasAppDir = existsSync(join(root, "app")) || existsSync(join(root, "src", "app"));
  const hasPagesDir = existsSync(join(root, "pages")) || existsSync(join(root, "src", "pages"));
  return hasPagesDir && !hasAppDir;
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
  // Drop the `init` subcommand token; what remains should be flags we recognize.
  const argv = process.argv.slice(3);
  const force = argv.includes("--force");
  const noInstall = argv.includes("--no-install");

  // Warn (don't fail) on anything unrecognized so a typo like `--no-instal`
  // doesn't silently behave as if the flag were never passed.
  const KNOWN_FLAGS = new Set(["--force", "--no-install"]);
  const unknown = argv.filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length) {
    skip(`ignoring unknown option${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    note(`known flags: --force, --no-install (see --help)`);
  }

  console.log(`\n${bold(cyan("claude-uidevkit"))} ${dim("· wiring up this project")}\n`);

  if (!existsSync(join(root, "package.json"))) {
    fail(`No package.json found in ${root}.`);
    note("Run this from the root of your Next.js project.");
    process.exitCode = 1;
    return;
  }

  // claude-uidevkit only works with the App Router. If the project looks
  // Pages-Router-only, say so loudly *before* we scaffold App-Router-only files —
  // a dim aside is too easy to miss when the route silently won't be served.
  if (isPagesRouterOnly(root)) {
    fail(`This looks like a Pages-Router project (pages/ found, no app/ or src/app/).`);
    note(`claude-uidevkit requires the Next.js App Router — the route below won't be served`);
    note(`under the Pages Router. Add an app/ (or src/app/) directory first.`);
    console.log("");
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
    // Separate our block from any prior content with a blank line — but only
    // when there *is* prior content, so a fresh/empty .gitignore doesn't start
    // with a stray blank line. `eol` finishes the last existing line if needed;
    // `sep` is the visual blank line between their content and our block.
    const eol = existing.length && !existing.endsWith("\n") ? "\n" : "";
    const sep = existing.length ? "\n" : "";
    writeFileSync(
      gitignore,
      `${existing}${eol}${sep}# claude-uidevkit capture queue (local, regenerable)\n${entry}\n`,
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
