import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// claude-uidevkit capture sink — DEV ONLY.
//
// Receives the context bundle the in-page <ClaudeUIDevkit/> overlay assembles when
// you click an element, and APPENDS it as a new entry under
// `.claude/claude-uidevkit/queue/` so you can capture several issues and fix them in
// one `/claude-uidevkit` run (which deletes each entry as it's handled). Folder is
// `claude-uidevkit`, not `_claude-uidevkit` — a leading underscore is a Next.js
// private folder, excluded from routing.
//
// NEVER served in production: the route short-circuits to 404 when
// NODE_ENV === "production" (and the overlay that calls it isn't mounted there
// either), so it adds no prod attack surface. Add `.claude/claude-uidevkit/` to
// your .gitignore (the `init` CLI does this for you).
//
// Wire it up by re-exporting the default handler from your route file:
//
//   // app/api/claude-uidevkit/route.ts
//   export { POST } from "claude-uidevkit/server";
//
// Or, to customize (extra allowed hosts, a different queue dir, a larger body cap):
//
//   import { createUIDevkitRoute } from "claude-uidevkit/server";
//   export const { POST } = createUIDevkitRoute({ extraHosts: [/\.trycloudflare\.com$/] });
// ─────────────────────────────────────────────────────────────────────────────

export type UIDevkitRouteOptions = {
  /**
   * Directory capture folders are written to. Default
   * `.claude/claude-uidevkit/queue` under `process.cwd()` (the repo root under
   * `next dev`). The `/claude-uidevkit` slash command reads from this same path.
   */
  queueDir?: string;
  /** Max accepted request body size, in bytes. Default 25 MB. */
  maxBodyBytes?: number;
  /**
   * Extra Host values (sans port) to accept beyond local loopback and ngrok
   * tunnels. Strings match the host case-insensitively for equality; RegExps are
   * tested against it (e.g. `/\.trycloudflare\.com$/`).
   */
  extraHosts?: (string | RegExp)[];
};

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — comfortably fits one capture

function defaultQueueDir(): string {
  return path.join(process.cwd(), ".claude", "claude-uidevkit", "queue");
}

// Defense-in-depth so a preview/staging deploy mistakenly left at
// NODE_ENV=development can't be abused as an unauthenticated file-write sink:
// reject any request whose Host isn't local loopback / an allow-listed dev tunnel.
function makeIsAllowedHost(extraHosts: (string | RegExp)[]) {
  return (request: NextRequest): boolean => {
    // The Host header (sans port) must be local loopback OR an ngrok dev tunnel —
    // so phone-via-ngrok capture keeps working. Anything else (a leaked preview
    // URL, a public domain) is rejected. The in-page overlay only ever posts
    // same-origin.
    const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
      return true;
    }
    if (/\.ngrok(-free)?\.(app|io)$/.test(host)) return true;
    return extraHosts.some((h) =>
      typeof h === "string" ? h.toLowerCase() === host : h.test(host),
    );
  };
}

const decode = (dataUrl: string) =>
  Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64");

/**
 * Build a Next.js App Router POST handler that writes claude-uidevkit captures to a
 * queue directory. Use this when you need to customize the allowed hosts, queue
 * location, or body cap; otherwise re-export the ready-made {@link POST}.
 */
export function createUIDevkitRoute(options: UIDevkitRouteOptions = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const queueDir = options.queueDir ?? defaultQueueDir();
  const isAllowedHost = makeIsAllowedHost(options.extraHosts ?? []);

  async function POST(request: NextRequest) {
    if (isProd) return new NextResponse(null, { status: 404 });
    if (!isAllowedHost(request)) return new NextResponse(null, { status: 404 });

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    // Guard against a missing/spoofed Content-Length: re-check the decoded size.
    if (JSON.stringify(payload).length > maxBodyBytes) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    const bundle = payload as { screenshot?: string; regionImage?: string } & Record<string, unknown>;
    const screenshot = typeof bundle.screenshot === "string" ? bundle.screenshot : null;
    const regionImage = typeof bundle.regionImage === "string" ? bundle.regionImage : null;

    // Strip the (large) data-URLs out of the JSON meta; PNGs are written separately.
    const meta = { ...bundle };
    delete meta.screenshot;
    delete meta.regionImage;

    try {
      // One folder per capture. The ms-timestamp prefix keeps entries in capture
      // order under a lexical sort; the random suffix avoids collisions when two
      // captures land in the same millisecond.
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const entryDir = path.join(queueDir, id);
      await mkdir(entryDir, { recursive: true });

      await writeFile(
        path.join(entryDir, "meta.json"),
        JSON.stringify({ ...meta, id, savedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );

      let screenshotWritten = false;
      if (screenshot) {
        await writeFile(path.join(entryDir, "screenshot.png"), decode(screenshot));
        screenshotWritten = true;
      }
      if (regionImage) {
        await writeFile(path.join(entryDir, "region.png"), decode(regionImage));
      }

      // How many captures are now queued (for the overlay's "N queued" toast).
      let count = 1;
      try {
        const entries = await readdir(queueDir, { withFileTypes: true });
        count = entries.filter((e) => e.isDirectory()).length;
      } catch {
        /* queueDir just created — count stays 1 */
      }

      return NextResponse.json({
        ok: true,
        id,
        dir: `.claude/claude-uidevkit/queue/${id}`,
        count,
        screenshot: screenshotWritten,
      });
    } catch (err) {
      return NextResponse.json(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }

  return { POST };
}

/** Ready-made POST handler with default config (loopback + ngrok hosts, 25 MB cap). */
export const { POST } = createUIDevkitRoute();
