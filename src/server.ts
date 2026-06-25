import { NextResponse, type NextRequest } from "next/server";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// claude-uidevkit capture sink — DEV ONLY.
//
// Receives the context bundle the in-page <ClaudeUIDevkit/> overlay assembles when
// you click an element, and APPENDS it as a new entry under
// `.claude/claude-uidevkit/queue/` so you can capture several issues and fix them in
// one `/uidevkit` run (which deletes each entry as it's handled). Folder is
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
   * `next dev`). The `/uidevkit` slash command reads from this same path.
   */
  queueDir?: string;
  /** Max accepted request body size, in bytes. Default 25 MB. */
  maxBodyBytes?: number;
  /**
   * Max accepted size of a single decoded image (screenshot / region PNG), in
   * bytes. Default 20 MB. Guards against a tiny base64 string decoding into an
   * oversized blob written to disk.
   */
  maxImageBytes?: number;
  /**
   * Max number of capture folders allowed to accumulate in the queue before new
   * captures are rejected. Stops a runaway/abusive client filling the disk.
   * Default 200.
   */
  maxQueueEntries?: number;
  /**
   * Extra Host values (sans port) to accept beyond local loopback and ngrok
   * tunnels. Strings match the host case-insensitively for equality; RegExps are
   * tested against it (e.g. `/\.trycloudflare\.com$/`).
   */
  extraHosts?: (string | RegExp)[];
};

const DEFAULT_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB — comfortably fits one capture
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB per decoded PNG/JPEG/WebP
const DEFAULT_MAX_QUEUE_ENTRIES = 200; // cap accumulated captures so disk can't be filled

function defaultQueueDir(): string {
  return path.join(process.cwd(), ".claude", "claude-uidevkit", "queue");
}

// Pull the bare hostname out of a `Host`-style header value, dropping the port.
// IPv6 is the tricky bit: a literal address is bracketed (`[::1]:3000` / `[::1]`)
// and the address itself is full of colons, so a naive `split(":")[0]` mangles it
// to `[` and the loopback allowlist below never matches. We strip the brackets and
// the trailing `:port`, normalising `[::1]` and bare `::1` to `::1`.
//
//   host:port           -> host          (e.g. localhost:3000 -> localhost)
//   [ipv6]:port / [ipv6]-> ipv6          (e.g. [::1]:3000      -> ::1)
//   bare ipv6 (no port) -> ipv6 as-is    (e.g. ::1             -> ::1)
function parseHostname(headerValue: string): string {
  const host = headerValue.trim().toLowerCase();
  if (host.startsWith("[")) {
    // Bracketed IPv6 literal: take everything inside the brackets.
    const close = host.indexOf("]");
    return close === -1 ? host.slice(1) : host.slice(1, close);
  }
  // A single colon means host:port. Two or more colons means a bare (unbracketed)
  // IPv6 literal carries no port — leave it intact.
  const firstColon = host.indexOf(":");
  if (firstColon !== -1 && host.indexOf(":", firstColon + 1) === -1) {
    return host.slice(0, firstColon);
  }
  return host;
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
    const host = parseHostname(request.headers.get("host") ?? "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return true;
    }
    if (/\.ngrok(-free)?\.(app|io)$/.test(host)) return true;
    return extraHosts.some((h) =>
      typeof h === "string" ? h.toLowerCase() === host : h.test(host),
    );
  };
}

// CSRF / cross-origin gate. While `next dev` is running, any site the developer
// opens in the same browser can `fetch`-POST to this route — the browser still
// sends `Host: localhost`, so the host allowlist alone lets it through, and the
// write side-effect (attacker-controlled meta.json + PNG into the queue, later
// fed verbatim into a `/uidevkit` Claude run) happens even though CORS hides the
// response. We require the request to be provably same-origin.
//
// `Sec-Fetch-Site` is set by the browser and cannot be spoofed by page JS:
//   - "same-origin"          → the overlay posting to its own origin. Allow.
//   - "same-site"/"cross-site"→ another page targeting us. Reject.
//   - "none" / absent        → no metadata (older browsers, non-browser clients).
//     Fall back to comparing the `Origin` host to the request Host; if there's no
//     Origin either (a plain server-to-server POST, e.g. curl), allow it — those
//     aren't the CSRF threat (no ambient browser cookies/origin in play).
function isSameOrigin(request: NextRequest): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "same-origin") return true;
  if (fetchSite && fetchSite !== "none") return false; // same-site / cross-site

  // No Sec-Fetch-Site (or "none"): verify the Origin host matches our Host.
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser caller, no ambient-credential CSRF risk
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // malformed Origin — treat as suspect
  }
  const host = (request.headers.get("host") ?? "").trim().toLowerCase();
  return originHost === host;
}

// Decode a `data:image/(png|jpeg|webp);base64,…` URL into raw bytes, validating
// that it really is one of the image types we expect and that its leading magic
// bytes match — we never want to write arbitrary attacker-controlled bytes to
// disk under a `.png` name. Returns `null` if the prefix is missing, the declared
// type is unsupported, the magic bytes don't line up, or the decoded blob exceeds
// `maxBytes`; the caller drops the image instead of writing it.
const IMAGE_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;
// Magic-byte signatures for the formats we accept.
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]; // \x89PNG\r\n\x1a\n
const JPEG_MAGIC = [0xff, 0xd8, 0xff]; // SOI marker
function startsWith(buf: Buffer, magic: number[]): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}
function decodeImage(dataUrl: string, maxBytes: number): Buffer | null {
  const match = IMAGE_PREFIX.exec(dataUrl);
  if (!match) return null;
  const type = match[1];
  const buf = Buffer.from(dataUrl.slice(match[0].length), "base64");
  if (buf.length === 0 || buf.length > maxBytes) return null;
  if (type === "png") {
    if (!startsWith(buf, PNG_MAGIC)) return null;
  } else if (type === "jpeg") {
    if (!startsWith(buf, JPEG_MAGIC)) return null;
  } else {
    // webp: "RIFF"...."WEBP"
    if (
      buf.length < 12 ||
      buf.toString("ascii", 0, 4) !== "RIFF" ||
      buf.toString("ascii", 8, 12) !== "WEBP"
    ) {
      return null;
    }
  }
  return buf;
}

/**
 * Build a Next.js App Router POST handler that writes claude-uidevkit captures to a
 * queue directory. Use this when you need to customize the allowed hosts, queue
 * location, or body cap; otherwise re-export the ready-made {@link POST}.
 */
export function createUIDevkitRoute(options: UIDevkitRouteOptions = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  const maxQueueEntries = options.maxQueueEntries ?? DEFAULT_MAX_QUEUE_ENTRIES;
  const queueDir = options.queueDir ?? defaultQueueDir();
  const isAllowedHost = makeIsAllowedHost(options.extraHosts ?? []);

  async function POST(request: NextRequest) {
    if (isProd) return new NextResponse(null, { status: 404 });
    if (!isAllowedHost(request)) return new NextResponse(null, { status: 404 });
    // CSRF gate: only same-origin posts (the overlay) get past here.
    if (!isSameOrigin(request)) return new NextResponse(null, { status: 403 });

    // Content-Length pre-check. The header is attacker-controlled, so it's only an
    // early-out, not the real boundary (the byte-accurate check below is). But if a
    // header is present and either non-numeric or over the cap, treat it as suspect
    // and reject — don't silently skip the check the way `Number.isFinite` on `NaN`
    // would.
    const rawContentLength = request.headers.get("content-length");
    if (rawContentLength !== null) {
      const contentLength = Number(rawContentLength);
      if (!Number.isFinite(contentLength) || contentLength > maxBodyBytes) {
        return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
      }
    }

    // Enforce the cap on the RAW bytes before parsing, so an oversized body is
    // never fully buffered as a parsed JS object. We read the body as bytes (one
    // buffering, unavoidable with the Web `Request` API), measure the true UTF-8
    // byte length, reject if over cap, and only then `JSON.parse`. Measuring bytes
    // — not `String#length` (UTF-16 code units) — is what makes the cap honest for
    // multibyte/CJK content.
    const bodyBuf = Buffer.from(await request.arrayBuffer());
    if (bodyBuf.byteLength > maxBodyBytes) {
      return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyBuf.toString("utf8"));
    } catch {
      return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
    }

    const bundle = payload as { screenshot?: string; regionImage?: string } & Record<string, unknown>;
    const screenshot = typeof bundle.screenshot === "string" ? bundle.screenshot : null;
    const regionImage = typeof bundle.regionImage === "string" ? bundle.regionImage : null;

    // Validate + decode the images up front; an unparseable/oversized/spoofed image
    // is dropped (not written) rather than failing the whole capture.
    const screenshotBuf = screenshot ? decodeImage(screenshot, maxImageBytes) : null;
    const regionBuf = regionImage ? decodeImage(regionImage, maxImageBytes) : null;

    // Strip the (large) data-URLs out of the JSON meta; PNGs are written separately.
    const meta = { ...bundle };
    delete meta.screenshot;
    delete meta.regionImage;

    try {
      // Disk-fill guard: refuse to grow the queue past a sane maximum. A stale or
      // abusive client could otherwise spam captures until the disk is full.
      try {
        const existing = await readdir(queueDir, { withFileTypes: true });
        const queued = existing.filter((e) => e.isDirectory()).length;
        if (queued >= maxQueueEntries) {
          return NextResponse.json(
            { ok: false, error: "capture queue full" },
            { status: 429 },
          );
        }
      } catch {
        /* queueDir doesn't exist yet — nothing queued, proceed */
      }

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
      if (screenshotBuf) {
        await writeFile(path.join(entryDir, "screenshot.png"), screenshotBuf);
        screenshotWritten = true;
      }
      if (regionBuf) {
        await writeFile(path.join(entryDir, "region.png"), regionBuf);
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
      // Log the full error server-side (it can carry filesystem paths) but return a
      // generic message so we never leak internals to the client.
      console.error("[claude-uidevkit] failed to write capture:", err);
      return NextResponse.json(
        { ok: false, error: "failed to write capture" },
        { status: 500 },
      );
    }
  }

  return { POST };
}

/** Ready-made POST handler with default config (loopback + ngrok hosts, 25 MB cap). */
export const { POST } = createUIDevkitRoute();
