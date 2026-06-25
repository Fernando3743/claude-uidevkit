"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeUIDevkit — in-page "tap an element → bundle full context for Claude" overlay.
// DEV ONLY. Mount it from app/layout.tsx behind a NODE_ENV guard so it is fully
// tree-shaken out of production builds.
//
// Two capture modes (both driven by Pointer Events, so mouse, touch + pen all work):
//   • Element (🐛 button or ⌘/Ctrl+Shift+E) — point at one element, tap/click it.
//   • Area    (⬚ button or ⌘/Ctrl+Shift+S) — drag a box over a region of the screen.
// Either way you then type a note and send. The bundle carries your note, the URL,
// the React owner-component chain, DOM/selector + styles (element) or the box coords
// + the components inside it (region), recent console errors, and an in-browser DOM
// screenshot (region mode adds a cropped close-up). It's POSTed to the API route
// (default /api/claude-uidevkit), which appends it as a new entry under
// `.claude/claude-uidevkit/queue/`. Capture as many as you like, then run
// `/uidevkit` in Claude Code to fix them all (each entry deleted as it's handled).
//
// Touch/phone capture is a headline feature (capture straight from your phone over an
// ngrok tunnel), so every interaction is wired to Pointer Events rather than mouse
// events: element pick drives its highlight from `pointermove` and finalizes on
// `pointerup`/`click`; region drag uses `setPointerCapture` (so a release ANYWHERE
// finalizes the box) plus `touch-action:none` (so the browser drags instead of
// scrolling). A coarse-pointer/keyboard path is provided where hover-before-tap or a
// mouse isn't available.
//
// Why owner chain, not file:line — React 19 removed fiber `_debugSource`. The
// `_debugOwner` walk still yields real component names (e.g. "Topbar"), which is a
// one-grep lookup to the source file. Raw `_debugStack` frames (bundled URLs) are
// captured too as a secondary hint.
// ─────────────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

export type ClaudeUIDevkitProps = {
  /**
   * Corner the floating controls + toast dock to. Default "bottom-right".
   * Move it if it collides with an app FAB (e.g. a chat widget).
   */
  position?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** API route the overlay POSTs captures to. Default "/api/claude-uidevkit". */
  endpoint?: string;
  /**
   * Extra React component names to treat as framework wrappers — demoted in the
   * owner chain so your own components surface first. Merged with the built-in set.
   */
  frameworkComponentNames?: string[];
};

type ConsoleEntry = { level: string; text: string; at: number };

// ── Module-level console/error ring buffer ───────────────────────────────────
// Installed once on first import so it captures errors that fire BEFORE the user
// enters pick mode (the whole point — you click after the error already showed).
const CONSOLE_BUFFER: ConsoleEntry[] = [];
const MAX_CONSOLE = 50;

// The "already hooked" flag lives on `window`, not in a module variable: Fast Refresh
// re-evaluates this module (resetting module scope) but keeps the same `window`, so a
// module-scoped boolean would let us double-patch console + add duplicate listeners on
// every edit. A window-scoped flag means a re-evaluated module sees the prior install.
declare global {
  interface Window {
    __claudeUidevkitHooked?: boolean;
  }
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
      if (typeof a === "object") {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(" ");
}

function push(level: string, text: string) {
  CONSOLE_BUFFER.push({ level, text: text.slice(0, 2000), at: Date.now() });
  if (CONSOLE_BUFFER.length > MAX_CONSOLE) CONSOLE_BUFFER.shift();
}

// Patch console + listen for global errors so the ring buffer already holds the error
// that prompted the capture (you click AFTER it showed). Returns a teardown that fully
// restores console and removes the listeners — called from the mounting effect's
// cleanup so Fast Refresh (or unmount) never leaves a leaked patch/listener behind.
function hookConsole(): () => void {
  if (typeof window === "undefined" || window.__claudeUidevkitHooked) return () => {};
  window.__claudeUidevkitHooked = true;

  // Remember the originals so we can restore the exact functions on teardown.
  const originals: { [K in "error" | "warn"]: typeof console.error } = {
    error: console.error,
    warn: console.warn,
  };
  for (const level of ["error", "warn"] as const) {
    const orig = originals[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, fmt(args));
      orig(...args);
    };
  }

  // Named handlers so removeEventListener can actually unbind them.
  const onError = (e: ErrorEvent) =>
    push("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  const onRejection = (e: PromiseRejectionEvent) =>
    push("error", `unhandledrejection: ${fmt([e.reason])}`);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    console.error = originals.error;
    console.warn = originals.warn;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.__claudeUidevkitHooked = false;
  };
}

// ── React fiber helpers ──────────────────────────────────────────────────────
function getFiber(el: Element): Record<string, unknown> | null {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  // @ts-expect-error indexing host node with the internal fiber key
  return key ? (el[key] as Record<string, unknown>) : null;
}

function fiberName(f: Record<string, unknown> | null | undefined): string | null {
  if (!f) return null;
  const t = (f.type ?? f.elementType) as
    | { displayName?: string; name?: string; render?: { displayName?: string; name?: string } }
    | string
    | null
    | undefined;
  if (!t) return null;
  if (typeof t === "function")
    return (
      (t as { displayName?: string; name?: string }).displayName ||
      (t as { name?: string }).name ||
      "Anonymous"
    );
  if (typeof t === "object")
    return t.displayName || (t.render && (t.render.displayName || t.render.name)) || "ForwardRef";
  return null; // host component (div/button/…)
}

// Known framework/library wrappers — kept in the chain but flagged so Claude
// prioritizes the app components. This built-in set is never mutated; the component
// merges it with the consumer's `frameworkComponentNames` prop into an effective Set
// (via useMemo) and passes that into `ownerChain` as an argument — a module-level
// singleton mutated from an effect would be shared across all instances and survive
// forever (and re-add on every Fast Refresh).
const BUILTIN_FRAMEWORK_NAMES: readonly string[] = [
  "LinkComponent",
  "Link",
  "Router",
  "InnerLayoutRouter",
  "OuterLayoutRouter",
  "RenderFromTemplateContext",
  "ClientPageRoot",
  "ClientSegmentRoot",
  "Image",
  "ImageElement",
];

function ownerChain(
  el: Element,
  frameworkNames: ReadonlySet<string>,
): { name: string; framework: boolean }[] {
  const out: { name: string; framework: boolean }[] = [];
  let node = getFiber(el);
  let guard = 0;
  while (node && guard++ < 80) {
    const n = fiberName(node);
    if (n && /^[A-Z]/.test(n) && !out.some((o) => o.name === n)) {
      out.push({ name: n, framework: frameworkNames.has(n) });
    }
    node = (node._debugOwner as Record<string, unknown>) || (node.return as Record<string, unknown>);
  }
  return out;
}

function debugStackFrames(el: Element): string[] {
  let node = getFiber(el);
  let guard = 0;
  while (node && guard++ < 40) {
    const stack = node._debugStack as { stack?: string } | undefined;
    if (stack && stack.stack) {
      return stack.stack
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("at ") && !/react-dom|react-stack|scheduler/.test(l))
        .slice(0, 6);
    }
    node = node.return as Record<string, unknown>;
  }
  return [];
}

// ── DOM helpers ──────────────────────────────────────────────────────────────
// CSS.escape() the ids: framework-generated ids routinely contain characters that are
// illegal raw in a selector (":", leading digits, "/", …), so an unescaped `#id`
// produces an invalid/unmatchable selector. `CSS.escape` is guarded for the rare
// engine that lacks it (older test envs) — it's a browser-only "use client" path.
function escId(id: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(id) : id;
}

function cssSelector(el: Element): string {
  if (el.id) return `#${escId(el.id)}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${escId(node.id)}`);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

function pickStyles(el: Element) {
  const cs = getComputedStyle(el);
  const keys = [
    "display", "position", "width", "height", "margin", "padding",
    "color", "backgroundColor", "fontSize", "fontFamily", "fontWeight",
    "flexDirection", "justifyContent", "alignItems", "gap",
    "zIndex", "overflow", "opacity", "transform", "border",
  ];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    if (v) out[k] = v;
  }
  return out;
}

// ── Region helpers ───────────────────────────────────────────────────────────
type Region = { left: number; top: number; width: number; height: number };

type RegionElement = {
  tag: string;
  text: string | null;
  selector: string;
  componentChain: { name: string; framework: boolean }[];
};

// Collect the distinct app components visible inside the selected box, so Claude can
// jump straight to the source files for that area. We sample a grid of points across
// the region and take the topmost element at each (document.elementFromPoint) — this
// captures what's actually visible (text, buttons, cards) without getting fooled by
// full-bleed background images or page-level wrappers. Deduped by component, capped.
//
// NB: this is point hit-testing, not box intersection — small/occluded elements that
// fall between sample points are omitted, so the list is a best-effort sample, not an
// exhaustive set. We run it at pointerup (when the box is finalized) rather than at
// submit time so it reflects the page the user actually drew on — by submit the page
// may have changed underneath the note panel.
function collectElementsInRegion(
  region: Region,
  frameworkNames: ReadonlySet<string>,
): RegionElement[] {
  const out: RegionElement[] = [];
  const seen = new Set<string>();
  const cols = 5;
  const rows = 4;
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const x = region.left + (region.width * i) / cols;
      const y = region.top + (region.height * j) / rows;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const el = document.elementFromPoint(x, y);
      if (!el || el === document.documentElement || el === document.body) continue;
      if (el.closest("[data-claude-uidevkit]")) continue;

      const chain = ownerChain(el, frameworkNames);
      const key = chain.find((c) => !c.framework)?.name ?? `${el.tagName}:${cssSelector(el)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || "").trim().slice(0, 120) || null,
        selector: cssSelector(el),
        componentChain: chain,
      });
      if (out.length >= 12) return out;
    }
  }
  return out;
}

// From the full-page screenshot, derive (1) a crop of the selected box and (2) the
// full image with that box outlined. Region coords are viewport-space; we normalize by
// document.body's rect so the mapping holds regardless of page scroll. The caller passes
// the body rect captured at FREEZE time (`bodyRect`) — the same geometry the snapshot and
// the on-screen backdrop used — so the crop math can't drift if reading the live rect now
// would differ (e.g. the scrollbar reappearing once scroll-lock is released). Falls back
// to a live read for the un-frozen path.
async function renderRegionImages(
  fullDataUrl: string,
  region: Region,
  bodyRect?: { left: number; top: number; width: number; height: number },
): Promise<{ outlined: string; cropped: string | null }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = fullDataUrl;
  });
  const rect = bodyRect ?? document.body.getBoundingClientRect();
  const scaleX = img.naturalWidth / rect.width;
  const scaleY = img.naturalHeight / rect.height;

  let sx = (region.left - rect.left) * scaleX;
  let sy = (region.top - rect.top) * scaleY;
  let sw = region.width * scaleX;
  let sh = region.height * scaleY;
  // Clamp to image bounds.
  sx = Math.max(0, Math.min(sx, img.naturalWidth));
  sy = Math.max(0, Math.min(sy, img.naturalHeight));
  sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
  sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));

  // Outlined full image.
  const fc = document.createElement("canvas");
  fc.width = img.naturalWidth;
  fc.height = img.naturalHeight;
  const fctx = fc.getContext("2d");
  let outlined = fullDataUrl;
  if (fctx) {
    fctx.drawImage(img, 0, 0);
    fctx.strokeStyle = "#f59e0b";
    fctx.lineWidth = Math.max(3, 3 * Math.min(scaleX, scaleY));
    fctx.strokeRect(sx, sy, sw, sh);
    outlined = fc.toDataURL("image/png");
  }

  // Cropped close-up.
  let cropped: string | null = null;
  const cc = document.createElement("canvas");
  cc.width = Math.round(sw);
  cc.height = Math.round(sh);
  const cctx = cc.getContext("2d");
  if (cctx) {
    cctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    cropped = cc.toDataURL("image/png");
  }

  return { outlined, cropped };
}

// ── Static style objects ──────────────────────────────────────────────────────
// Hoisted to module scope so they aren't re-allocated on every render (the hover path
// re-renders many times a second). Anything with a per-render value (positions, sizes,
// active/idle colors) is composed from these at the call site.
const Z_TOP = 2147483647;
const Z_HIGHLIGHT = 2147483646;
const Z_FREEZE = 2147483645;

const highlightBox: CSSProperties = {
  position: "fixed",
  border: "2px solid #f59e0b",
  background: "rgba(245,158,11,0.12)",
  borderRadius: 4,
  pointerEvents: "none",
  zIndex: Z_HIGHLIGHT,
};
const highlightLabel: CSSProperties = {
  position: "absolute",
  top: -22,
  left: 0,
  background: "#f59e0b",
  color: "#1a1205",
  font: "600 11px ui-monospace, monospace",
  padding: "2px 6px",
  borderRadius: 3,
  whiteSpace: "nowrap",
};
const freezeHint: CSSProperties = {
  position: "fixed",
  top: 16,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: Z_TOP,
  padding: "8px 14px",
  borderRadius: 999,
  pointerEvents: "none",
  font: "600 12px ui-monospace, monospace",
  color: "#1a1205",
  background: "#f59e0b",
  boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
};
const dragRectBox: CSSProperties = {
  position: "fixed",
  border: "2px solid #f59e0b",
  background: "rgba(245,158,11,0.12)",
  boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
  pointerEvents: "none",
};
const notePanel: CSSProperties = {
  position: "fixed",
  zIndex: Z_TOP,
  background: "rgba(28,25,23,0.97)",
  border: "1px solid #f59e0b",
  borderRadius: 10,
  padding: 12,
  boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  backdropFilter: "blur(6px)",
  color: "#fde68a",
  font: "500 12px ui-monospace, monospace",
};
const noteTextarea: CSSProperties = {
  width: "100%",
  resize: "vertical",
  boxSizing: "border-box",
  background: "rgba(0,0,0,0.35)",
  border: "1px solid rgba(245,158,11,0.4)",
  borderRadius: 6,
  color: "#fef3c7",
  font: "500 12px ui-monospace, monospace",
  padding: 8,
  outline: "none",
};
const toastBase: CSSProperties = {
  position: "fixed",
  zIndex: Z_TOP,
  maxWidth: 320,
  padding: "10px 14px",
  borderRadius: 8,
  font: "500 12px ui-monospace, monospace",
  boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
};
const toastStyle: CSSProperties = {
  ...toastBase,
  color: "#dcfce7",
  background: "rgba(22,101,52,0.95)",
};
const toastErrStyle: CSSProperties = {
  ...toastBase,
  color: "#fee2e2",
  background: "rgba(127,29,29,0.95)",
};
// Visually-hidden but available to assistive tech (used for the idle live regions so
// they're persistently mounted but invisible until a message swaps in).
const srOnly: CSSProperties = {
  position: "fixed",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  border: 0,
};

export function ClaudeUIDevkit({
  position = "bottom-right",
  endpoint = "/api/claude-uidevkit",
  frameworkComponentNames,
}: ClaudeUIDevkitProps = {}) {
  const [mode, setMode] = useState<"off" | "element" | "region">("off");
  const [hovered, setHovered] = useState<Element | null>(null);
  const [selected, setSelected] = useState<Element | null>(null); // picked element, awaiting a note
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // live region drag
  const [region, setRegion] = useState<Region | null>(null); // finalized box, awaiting a note
  // Components sampled inside the box at the instant it was finalized (pointerup), while
  // the page still matched the freeze-frame the user drew on — not re-sampled at submit.
  const [regionElements, setRegionElements] = useState<RegionElement[]>([]);
  const [frozen, setFrozen] = useState<string | null>(null); // freeze-frame backdrop for region mode
  // document.body's viewport rect captured at freeze time, so the backdrop is pinned to a
  // fixed coordinate space (reading window.scrollX/Y live in render would drift, and is an
  // impure render read). Body scroll is locked while the drag layer is up (see effect).
  const [frozenGeom, setFrozenGeom] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const [note, setNote] = useState("");
  const [capturing, setCapturing] = useState(false); // hide overlay UI for the screenshot
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  // Bumped on scroll/resize/visualViewport changes so the live highlight boxes (which
  // read getBoundingClientRect during render) recompute and don't desync from the page.
  const [, forceGeom] = useState(0);

  const active = mode === "element"; // derived: element-pick mode is on
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Element focus to restore when the note panel closes (so a keyboard user isn't dumped
  // back to <body>). Captured right before we move focus into the textarea.
  const restoreFocusRef = useRef<Element | null>(null);
  // The flash() dismissal timer, tracked so we can clear a pending one before scheduling
  // a new toast and on unmount (avoids setState-after-unmount + overlapping-toast races).
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Effective framework-wrapper set: the immutable built-ins merged with the consumer's
  // prop. Recomputed only when the prop changes; passed into ownerChain rather than
  // mutating a shared module-level singleton.
  const frameworkNames = useMemo(
    () => new Set<string>([...BUILTIN_FRAMEWORK_NAMES, ...(frameworkComponentNames ?? [])]),
    [frameworkComponentNames],
  );

  // hookConsole returns a teardown (restore console + remove listeners); run it on
  // cleanup so Fast Refresh / unmount never leaves a leaked patch behind.
  useEffect(() => hookConsole(), []);

  // Coarse pointer (touch/pen) — used to surface touch-appropriate copy and to bump
  // touch-target sizes. Re-evaluated if the input modality changes (e.g. a 2-in-1).
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Focus the note box as soon as an element or region is picked, remembering what had
  // focus first so we can restore it when the panel closes (see cancelPending/capture).
  useEffect(() => {
    if (selected || region) {
      if (!restoreFocusRef.current) restoreFocusRef.current = document.activeElement;
      noteRef.current?.focus();
    }
  }, [selected, region]);

  const restoreFocus = useCallback(() => {
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el instanceof HTMLElement) el.focus();
  }, []);

  const flash = useCallback((msg: string, ok = true) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setToast({ msg, ok });
    flashTimerRef.current = setTimeout(() => {
      setToast(null);
      flashTimerRef.current = null;
    }, ok ? 3500 : 6000);
  }, []);

  // Clear any pending toast timer on unmount.
  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // ── Screenshot — in-browser DOM rasterization ──────────────────────────────
  // Uses html-to-image instead of getDisplayMedia, so there is NO browser
  // "share this tab" permission prompt and NO "Sharing this tab" chrome bar. It
  // rasterizes the live DOM at the moment of capture, so transient state (modals,
  // toasts, hover) is preserved. Caveat: WebGL/<canvas> content renders blank
  // because pixel readback needs preserveDrawingBuffer. The library is dynamically
  // imported so it's only loaded on first capture (and never in the tree-shaken-out
  // production build).
  const grabScreenshot = useCallback(async (): Promise<string | null> => {
    try {
      const { toPng } = await import("html-to-image");
      return await toPng(document.body, {
        cacheBust: true,
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2), // cap file size
        // Never include the ClaudeUIDevkit overlay itself in the shot.
        filter: (node) =>
          !(node instanceof Element && node.closest("[data-claude-uidevkit]") !== null),
      });
    } catch (err) {
      flash(
        `Screenshot skipped: ${err instanceof Error ? err.message : "?"}. Is "html-to-image" installed?`,
        false,
      );
      return null;
    }
  }, [flash]);

  // ── Freeze-frame for region mode ───────────────────────────────────────────
  // When region mode turns on, snapshot the page BEFORE the drag layer mounts (the
  // layer would steal the pointer and drop any :hover). We draw on this frozen image
  // and reuse it as the capture, so an on-hover state stays visible + captured.
  // The snapshot is toPng(document.body), so we record body's size + the current scroll
  // offset here and pin the backdrop to that fixed space (see render) — region capture
  // covers the CURRENT VIEWPORT only, so we also lock body scroll below so the stale
  // snapshot can't drift out from under the drag layer. On coarse pointers the trigger
  // is the ⬚ button (no keyboard shortcut needed).
  useEffect(() => {
    if (mode !== "region") return;
    let cancelled = false;
    (async () => {
      setFrozen(null); // clear any stale frame (inside async, not the effect body)
      // Capture document.body's viewport rect up front and display the backdrop at exactly
      // that left/top/width. The snapshot is toPng(document.body) (pixel space = body's
      // rect), and renderRegionImages maps the box back through the SAME body rect, so
      // pinning the displayed image to bodyRect makes the backdrop you draw on pixel-align
      // with both the snapshot and the crop math (M1) — far more robust than width:100vw,
      // which includes the scrollbar and ignores body margins / centered layouts. Scroll is
      // locked below, so these viewport-relative coordinates stay valid for the session.
      const r = document.body.getBoundingClientRect();
      setFrozenGeom({ left: r.left, top: r.top, width: r.width, height: r.height });
      const f = await grabScreenshot();
      if (!cancelled) setFrozen(f);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, grabScreenshot]);

  // Lock body scroll while region mode is active so the page can't scroll behind the
  // stale freeze-frame (which would misalign the box vs the live DOM). Restored on exit.
  useEffect(() => {
    if (mode !== "region") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mode]);

  // Keep the live highlight boxes glued to the page. The hovered/selected/region rects
  // are read via getBoundingClientRect during render, so on scroll/resize/zoom we bump a
  // tick to re-render. Only mounted when there's something on-screen to keep aligned;
  // coalesced to one update per frame.
  const geomReactive = active || selected != null || region != null;
  useEffect(() => {
    if (!geomReactive || typeof window === "undefined") return;
    let raf = 0;
    const onGeom = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        forceGeom((n) => n + 1);
      });
    };
    window.addEventListener("scroll", onGeom, true);
    window.addEventListener("resize", onGeom);
    window.visualViewport?.addEventListener("resize", onGeom);
    window.visualViewport?.addEventListener("scroll", onGeom);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onGeom, true);
      window.removeEventListener("resize", onGeom);
      window.visualViewport?.removeEventListener("resize", onGeom);
      window.visualViewport?.removeEventListener("scroll", onGeom);
    };
  }, [geomReactive]);

  // ── Capture an element → build bundle → POST ───────────────────────────────
  const capture = useCallback(
    async (el: Element, instruction: string) => {
      setMode("off");
      setHovered(null);
      setCapturing(true); // hide overlay UI so it isn't in the screenshot
      // let React paint the hidden state before grabbing the frame
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const screenshot = await grabScreenshot();

      const rect = el.getBoundingClientRect();
      const bundle = {
        mode: "element",
        url: location.href,
        path: location.pathname + location.search,
        title: document.title,
        instruction: instruction.trim() || null,
        capturedAt: new Date().toISOString(),
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        target: {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          classes: el.className && typeof el.className === "string" ? el.className : null,
          text: (el.textContent || "").trim().slice(0, 200) || null,
          selector: cssSelector(el),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
          },
          outerHTML: el.outerHTML.slice(0, 1500),
          styles: pickStyles(el),
          ariaRole: el.getAttribute("role"),
        },
        componentChain: ownerChain(el, frameworkNames),
        renderStack: debugStackFrames(el),
        recentConsole: CONSOLE_BUFFER.slice(-15),
        screenshot,
      };

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bundle),
        });
        const json = await res.json();
        if (json.ok) {
          const comp = bundle.componentChain.find((c) => !c.framework)?.name ?? bundle.target.tag;
          const n = json.count ?? 1;
          flash(
            `Captured ${comp}${screenshot ? "" : " (no screenshot)"} → ${n} queued. Run /uidevkit`,
          );
        } else {
          flash(`Save failed: ${json.error ?? "unknown"}`, false);
        }
      } catch (err) {
        flash(`POST failed: ${err instanceof Error ? err.message : "?"}`, false);
      } finally {
        setCapturing(false);
        setSelected(null);
        setNote("");
        restoreFocus();
      }
    },
    [grabScreenshot, flash, endpoint, frameworkNames, restoreFocus],
  );

  // ── Capture a region → build bundle → POST ─────────────────────────────────
  const captureRegion = useCallback(
    async (reg: Region, instruction: string) => {
      setMode("off");
      setCapturing(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      // Reuse the freeze-frame (captured with hover intact) if we have one.
      const full = frozen ?? (await grabScreenshot());
      let outlined: string | null = full;
      let regionImage: string | null = null;
      if (full) {
        try {
          // When the snapshot is the freeze-frame, map the crop through the body rect we
          // recorded at freeze time (so it matches the snapshot + backdrop exactly); for a
          // fresh fallback snapshot, let renderRegionImages read the live rect.
          const r = await renderRegionImages(
            full,
            reg,
            full === frozen ? frozenGeom ?? undefined : undefined,
          );
          outlined = r.outlined;
          regionImage = r.cropped;
        } catch {
          /* keep the un-annotated full image as a fallback */
        }
      }

      // Sampled at pointerup (while the page still matched the freeze-frame), not now —
      // by submit time the live DOM may have changed under the note panel.
      const elementsInRegion = regionElements;
      const bundle = {
        mode: "region",
        url: location.href,
        path: location.pathname + location.search,
        title: document.title,
        instruction: instruction.trim() || null,
        capturedAt: new Date().toISOString(),
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        region: {
          x: Math.round(reg.left),
          y: Math.round(reg.top),
          w: Math.round(reg.width),
          h: Math.round(reg.height),
        },
        elementsInRegion,
        recentConsole: CONSOLE_BUFFER.slice(-15),
        screenshot: outlined,
        regionImage,
      };

      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bundle),
        });
        const json = await res.json();
        if (json.ok) {
          const n = json.count ?? 1;
          flash(`Captured area (${elementsInRegion.length} comps) → ${n} queued. Run /uidevkit`);
        } else {
          flash(`Save failed: ${json.error ?? "unknown"}`, false);
        }
      } catch (err) {
        flash(`POST failed: ${err instanceof Error ? err.message : "?"}`, false);
      } finally {
        setCapturing(false);
        setRegion(null);
        setRegionElements([]);
        setFrozen(null);
        setFrozenGeom(null);
        setNote("");
        restoreFocus();
      }
    },
    [grabScreenshot, flash, frozen, frozenGeom, endpoint, regionElements, restoreFocus],
  );

  // Reset all transient capture state and restore focus. Shared by Escape + Cancel so
  // they behave identically and we don't double-maintain the teardown list.
  const resetAll = useCallback(() => {
    setMode("off");
    setSelected(null);
    setRegion(null);
    setRegionElements([]);
    setDrag(null);
    setFrozen(null);
    setFrozenGeom(null);
    setNote("");
    restoreFocus();
  }, [restoreFocus]);

  // Freeze a pick and open the note input; the actual capture happens on submit. Shared
  // by the pointer click handler and the keyboard pick (Enter in element mode).
  const pickElement = useCallback((el: Element) => {
    setSelected(el);
    setMode("off");
    setHovered(null);
  }, []);

  // ── Pick-mode keyboard wiring ──────────────────────────────────────────────
  // True when focus is inside an editable field the overlay does NOT own — we must not
  // hijack/preventDefault the user's typing in their own app inputs.
  const inForeignEditable = (t: EventTarget | null): boolean => {
    if (!(t instanceof Element)) return false;
    if (t.closest("[data-claude-uidevkit]")) return false; // our own textarea is fine
    return (
      t instanceof HTMLInputElement ||
      t instanceof HTMLTextAreaElement ||
      (t instanceof HTMLElement && t.isContentEditable)
    );
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inOurUI =
        e.target instanceof Element && e.target.closest("[data-claude-uidevkit]") !== null;
      // Escape: tear everything down — but NOT when focus is inside our own note panel,
      // where the textarea's local onKeyDown already handles Escape. This capture-phase
      // handler runs first, so without this guard Escape in the note would double-fire.
      if (e.key === "Escape") {
        if (inOurUI) return;
        resetAll();
        return;
      }
      // Don't fire the global E/S chords (or Enter-pick) while the user is typing in their
      // own app field; only react when not in a foreign editable.
      if (inForeignEditable(e.target)) return;

      // Mode chords. Ignore mode toggles while a note is pending (selected || region) so a
      // stray E/S doesn't yank the mode out from under an open panel.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        if (selected || region) return;
        e.preventDefault();
        setMode((m) => (m === "element" ? "off" : "element"));
        return;
      }
      // NB: ⌘/Ctrl+Shift+S collides with browser/OS "save page"/screenshot shortcuts. We
      // keep it (the ⬚ button is the discoverable path) but only preventDefault when we're
      // actually toggling and the user isn't typing in their own input (guarded above).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        if (selected || region) return;
        e.preventDefault();
        setMode((m) => (m === "region" ? "off" : "region"));
        return;
      }
      // Keyboard pick: while in element mode with no pointer, Enter picks whatever element
      // currently has focus (a keyboard user can Tab to it). Keeps the mode usable sans
      // mouse — see M11.
      if (active && e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const focused = document.activeElement;
        if (
          focused &&
          focused !== document.body &&
          !focused.closest("[data-claude-uidevkit]")
        ) {
          e.preventDefault();
          pickElement(focused);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, selected, region, resetAll, pickElement]);

  // ── Pick-mode pointer wiring ───────────────────────────────────────────────
  // Pointer Events (not mouse) so touch + pen work too: the highlight tracks
  // `pointermove`, and we pick on `click` (so a tap synthesizes the pick on touch as
  // well). On coarse pointers there's no hover-before-tap; the pointerdown that precedes
  // the synthesized click still flashes the highlight box, and the active pill labels the
  // mode ("tap an element"), so the pick isn't entirely blind.
  useEffect(() => {
    // When inactive we attach no listeners; the highlight box is gated on `active`
    // in render, so any stale `hovered` simply isn't drawn (no setState needed here).
    if (!active) return;
    const isOurs = (t: EventTarget | null) =>
      t instanceof Element && t.closest("[data-claude-uidevkit]") !== null;

    // rAF-coalesce the hover update and skip when the target hasn't changed, so the
    // 80-deep owner-chain walk + getBoundingClientRect read don't run on every single
    // pointermove (which would jank the host app — see M9).
    let raf = 0;
    let pendingTarget: Element | null = null;
    const flush = () => {
      raf = 0;
      setHovered((prev) => (prev === pendingTarget ? prev : pendingTarget));
    };
    const onMove = (e: PointerEvent) => {
      if (isOurs(e.target)) return;
      if (!(e.target instanceof Element)) return;
      pendingTarget = e.target;
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onClick = (e: MouseEvent) => {
      if (isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target instanceof Element) pickElement(e.target);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    // Crosshair is a desktop nicety only (a no-op on touch); the dimmed overlay + the
    // active pill are the real cues, so we don't rely on it alone.
    document.body.style.cursor = "crosshair";
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.body.style.cursor = "";
    };
  }, [active, pickElement]);

  // getBoundingClientRect reads gated on the relevant state being present (we don't read
  // hovered's rect unless element mode is active). hoverName/selName are memoized on the
  // element so the owner-chain walk doesn't re-run on every unrelated render (M9).
  const hoverRect = active && hovered ? hovered.getBoundingClientRect() : undefined;
  const hoverName = useMemo(
    () => (hovered ? ownerChain(hovered, frameworkNames).find((c) => !c.framework)?.name : null),
    [hovered, frameworkNames],
  );

  const selRect = selected?.getBoundingClientRect();
  const selName = useMemo(
    () => (selected ? ownerChain(selected, frameworkNames).find((c) => !c.framework)?.name : null),
    [selected, frameworkNames],
  );

  // Live drag rectangle (normalized) while drawing a region.
  const dragRect = drag
    ? {
        left: Math.min(drag.x0, drag.x1),
        top: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : null;

  // The rect the note panel anchors to: a picked element OR a finalized region.
  const pendingRect = selRect
    ? { left: selRect.left, top: selRect.top, bottom: selRect.bottom, width: selRect.width, height: selRect.height }
    : region
      ? { left: region.left, top: region.top, bottom: region.top + region.height, width: region.width, height: region.height }
      : null;

  // Measured note-panel height (the textarea is resize:vertical, so a hardcoded guess
  // can leave it docked under the bottom edge / soft keyboard). Measured after mount and
  // re-measured on geom changes via the panel ref's getBoundingClientRect.
  const [panelH, setPanelH] = useState(0);
  useEffect(() => {
    if (!(selected || region)) return;
    const measure = () => {
      const r = panelRef.current?.getBoundingClientRect();
      if (r) setPanelH(r.height);
    };
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (ro && panelRef.current) ro.observe(panelRef.current);
    return () => ro?.disconnect();
  }, [selected, region]);

  // Anchor the note panel just below the pending rect, clamped to the visible viewport.
  // Width is responsive (never wider than the viewport minus a gutter), and `left` is
  // clamped into [8, max(8, viewportW - width - 8)] so the lower bound can't exceed the
  // upper bound on narrow phones (which would push the panel off-screen — H2). On mobile
  // we key the height/offset to window.visualViewport so the panel stays above the soft
  // keyboard (M4); visualViewport shrinks when the keyboard opens, innerHeight doesn't.
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  const viewportW = typeof window !== "undefined" ? vv?.width ?? innerWidth : 1200;
  const viewportH = typeof window !== "undefined" ? vv?.height ?? innerHeight : 800;
  const viewportTop = vv?.offsetTop ?? 0;
  const viewportLeft = vv?.offsetLeft ?? 0;
  const panelW = Math.min(340, viewportW - 16);
  // Fall back to a sane guess until the first measurement lands.
  const measuredH = panelH || 200;
  const panelPos = pendingRect
    ? {
        left: Math.min(
          Math.max(8 + viewportLeft, pendingRect.left),
          Math.max(8 + viewportLeft, viewportLeft + viewportW - panelW - 8),
        ),
        top: Math.min(
          Math.max(8 + viewportTop, pendingRect.bottom + 8),
          Math.max(8 + viewportTop, viewportTop + viewportH - measuredH - 8),
        ),
      }
    : { left: 8 + viewportLeft, top: 8 + viewportTop };

  const submitPending = () => {
    if (selected) capture(selected, note);
    else if (region) captureRegion(region, note);
  };
  const cancelPending = resetAll;

  // ── Corner placement for the floating controls + toast ─────────────────────
  // On coarse pointers keep extra distance from the screen edge where OS edge-gestures
  // (back-swipe, control center) live, and bump touch-target sizes below (M5).
  const edgeGap = coarsePointer ? 24 : 16;
  const isBottom = position.startsWith("bottom");
  const isRight = position.endsWith("right");
  const vEdge: CSSProperties = isBottom ? { bottom: edgeGap } : { top: edgeGap };
  const hEdge: CSSProperties = isRight ? { right: edgeGap } : { left: edgeGap };
  const controlsAlign = isRight ? "flex-end" : "flex-start";
  const toastVEdge: CSSProperties = isBottom ? { bottom: 60 } : { top: 60 };

  // On touch/small viewports give pills + buttons a ≥44px target (WCAG 2.5.5 / iOS 44px
  // / Android 48dp); on desktop keep the compact size.
  const pillBase: CSSProperties = {
    padding: coarsePointer ? "12px 18px" : "8px 12px",
    minHeight: coarsePointer ? 44 : undefined,
    borderRadius: 999,
    border: "none",
    cursor: "pointer",
    font: "600 12px ui-monospace, monospace",
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)",
  };
  const pillIdle: CSSProperties = { ...pillBase, color: "#fde68a", background: "rgba(28,25,23,0.92)" };
  const pillActive: CSSProperties = { ...pillBase, color: "#1a1205", background: "#f59e0b" };

  // Note-panel button sizing — also ≥44px on touch.
  const buttonPadV = coarsePointer ? 12 : 6;
  const buttonMinH = coarsePointer ? 44 : undefined;

  // Static "⌘" (this is a local-only dev tool — keeps server/client render identical
  // so there's no hydration mismatch); the tooltip notes Ctrl for portability.
  const shortcutMod = "⌘";
  const kbdStyle: CSSProperties = {
    marginLeft: 4,
    padding: "1px 5px",
    borderRadius: 4,
    background: "rgba(0,0,0,0.25)",
    fontSize: 10,
    fontWeight: 600,
    verticalAlign: "middle",
  };

  return (
    <div data-claude-uidevkit>
      {/* Highlight box. position:fixed + getBoundingClientRect are both in layout-viewport
          coords, so they stay aligned on scroll/resize (we re-render on those via the geom
          effect). Under an active pinch-zoom the visual viewport is offset/scaled from the
          layout viewport; browsers disagree on how fixed elements track that, so the box
          can drift a few px mid-pinch. It re-aligns once the gesture settles — accepted as
          a known limitation rather than a fragile per-browser offset hack. */}
      {active && hoverRect && !capturing && (
        <div
          style={{
            ...highlightBox,
            left: hoverRect.x,
            top: hoverRect.y,
            width: hoverRect.width,
            height: hoverRect.height,
          }}
        >
          <span style={highlightLabel}>
            {hovered?.tagName.toLowerCase()}
            {hoverName ? ` · ${hoverName}` : ""}
          </span>
        </div>
      )}

      {/* Frozen highlight on the picked element / region while the note box is open */}
      {pendingRect && !capturing && (
        <div
          style={{
            ...highlightBox,
            left: pendingRect.left,
            top: pendingRect.top,
            width: pendingRect.width,
            height: pendingRect.height,
          }}
        />
      )}

      {/* Freeze-frame backdrop — the page snapshot taken when region mode began, so any
          on-hover state stays visible while you draw + gets captured. Displayed at exactly
          document.body's viewport rect (captured at freeze time), so it pixel-aligns with
          the toPng(document.body) snapshot AND with renderRegionImages' crop math, which
          map through the same body rect (M1/M3). Scroll is locked while region mode is up,
          so this fixed rect stays correct (no live window.scrollX/Y read in render). */}
      {mode === "region" && frozen && frozenGeom && !capturing && (
        // eslint-disable-next-line @next/next/no-img-element -- dev-only base64 freeze-frame, not an optimizable asset
        <img
          src={frozen}
          alt=""
          style={{
            position: "fixed",
            top: frozenGeom.top,
            left: frozenGeom.left,
            width: frozenGeom.width,
            height: "auto",
            pointerEvents: "none",
            zIndex: Z_FREEZE,
          }}
        />
      )}

      {/* "Freezing…" hint while the snapshot is taken (pointer-events:none so it does
          NOT steal the :hover we're trying to capture). On touch there's no parked mouse,
          so the copy adapts. */}
      {mode === "region" && !frozen && !capturing && (
        <div role="status" aria-live="polite" style={freezeHint}>
          {coarsePointer ? "❄ Freezing page… hold still" : "❄ Freezing page… keep the mouse still"}
        </div>
      )}

      {/* Once the freeze is ready, announce that the page is ready to box (the drag layer
          itself is silent to AT). Visually hidden — the dimmed page + crosshair are the
          sighted cue. */}
      {mode === "region" && frozen && !region && !capturing && (
        <div role="status" aria-live="polite" style={srOnly}>
          Page frozen. Drag a box over the area to capture.
        </div>
      )}

      {/* Region drawing layer — owns the drag so it never clicks/selects the page.
          Only mounts AFTER the freeze-frame is ready (else it'd steal the :hover). */}
      {mode === "region" && frozen && !region && !capturing && (
        <div
          // Pointer Events unify mouse/touch/pen. setPointerCapture means a release
          // ANYWHERE (even off the layer / outside the window) still fires pointerup here
          // and finalizes the box. touch-action:none stops the browser from scrolling
          // instead of reporting the drag on touch (H1 + the "release outside" L finding).
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          }}
          onPointerMove={(e) => {
            if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY });
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            // Compute the final rect from the up-coords (don't rely on a trailing move).
            const final = drag
              ? {
                  left: Math.min(drag.x0, e.clientX),
                  top: Math.min(drag.y0, e.clientY),
                  width: Math.abs(e.clientX - drag.x0),
                  height: Math.abs(e.clientY - drag.y0),
                }
              : null;
            if (final && final.width > 6 && final.height > 6) {
              // Sample the components NOW, while the page still matches the freeze-frame
              // the user drew on — not at submit time (L: live-DOM-at-submit drift). The
              // drag layer is on top and hit-testable, so drop its pointer-events first
              // (it's about to unmount anyway) — otherwise elementFromPoint just hits it
              // and the [data-claude-uidevkit] guard skips every sample. The freeze-frame
              // img is already pointer-events:none, so points see through to the live page.
              e.currentTarget.style.pointerEvents = "none";
              setRegionElements(collectElementsInRegion(final, frameworkNames));
              setRegion(final);
            }
            setDrag(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            cursor: "crosshair",
            touchAction: "none",
            zIndex: Z_HIGHLIGHT,
            // Subtle dim so the page is clearly in "select" mode.
            background: drag ? "transparent" : "rgba(0,0,0,0.04)",
          }}
        >
          {dragRect && (
            <div
              style={{
                ...dragRectBox,
                left: dragRect.left,
                top: dragRect.top,
                width: dragRect.width,
                height: dragRect.height,
              }}
            />
          )}
        </div>
      )}

      {/* Note input — type the change you want Claude to make, then send */}
      {(selected || region) && !capturing && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Describe the change for Claude"
          style={{
            ...notePanel,
            left: panelPos.left,
            top: panelPos.top,
            width: panelW,
          }}
        >
          <div style={{ marginBottom: 8, opacity: 0.85 }}>
            {selected
              ? `${selected.tagName.toLowerCase()}${selName ? ` · ${selName}` : ""}`
              : region
                ? `Area ${Math.round(region.width)}×${Math.round(region.height)}`
                : ""}
          </div>
          <textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submitPending();
              }
              // The global capture-phase handler bails when focus is inside our UI, so
              // Escape here cancels exactly once. stopPropagation keeps it from reaching
              // app-level keydown listeners too.
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                cancelPending();
              }
            }}
            placeholder="What should Claude change here? (e.g. this button is misaligned on mobile)"
            rows={3}
            style={noteTextarea}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={cancelPending}
              style={{
                padding: `${buttonPadV}px 14px`,
                minHeight: buttonMinH,
                borderRadius: 6,
                border: "1px solid rgba(245,158,11,0.4)",
                background: "transparent",
                color: "#fcd34d",
                cursor: "pointer",
                font: "600 12px ui-monospace, monospace",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submitPending}
              style={{
                padding: `${buttonPadV}px 14px`,
                minHeight: buttonMinH,
                borderRadius: 6,
                border: "none",
                background: "#f59e0b",
                color: "#1a1205",
                cursor: "pointer",
                font: "700 12px ui-monospace, monospace",
              }}
            >
              Send to Claude <kbd style={kbdStyle} aria-hidden="true">⌘⏎</kbd>
            </button>
          </div>
        </div>
      )}

      {/* Floating controls */}
      {!capturing && !selected && !region && (
        <div
          style={{
            position: "fixed",
            ...vEdge,
            ...hEdge,
            zIndex: Z_TOP,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            alignItems: controlsAlign,
          }}
        >
          {mode === "off" && (
            <>
              <button
                type="button"
                onClick={() => setMode("element")}
                title="Pick a single element (⌘/Ctrl+Shift+E)"
                aria-label="Pick a single element"
                style={pillIdle}
              >
                <span aria-hidden="true">🐛</span> Element{" "}
                <kbd style={kbdStyle} aria-hidden="true">
                  {shortcutMod}⇧E
                </kbd>
              </button>
              <button
                type="button"
                onClick={() => setMode("region")}
                title="Drag a box over an area (⌘/Ctrl+Shift+S)"
                aria-label="Drag a box over an area"
                style={pillIdle}
              >
                <span aria-hidden="true">⬚</span> Area{" "}
                <kbd style={kbdStyle} aria-hidden="true">
                  {shortcutMod}⇧S
                </kbd>
              </button>
            </>
          )}
          {mode === "element" && (
            <button
              type="button"
              onClick={() => setMode("off")}
              aria-label="Stop picking element"
              style={pillActive}
            >
              <span aria-hidden="true">●</span>{" "}
              {coarsePointer ? "tap an element — Esc" : "picking element — Esc"}
            </button>
          )}
          {mode === "region" && (
            <button
              type="button"
              onClick={() => setMode("off")}
              aria-label="Stop selecting area"
              style={pillActive}
            >
              <span aria-hidden="true">●</span>{" "}
              {coarsePointer ? "drag a box — Esc" : "drag to select — Esc"}
            </button>
          )}
        </div>
      )}

      {/* Toast — the only signal a capture succeeded/failed, so it must reach AT. We keep
          TWO persistent live regions (a polite status + an assertive alert) mounted at
          all times and swap the text into the matching one, so screen readers announce on
          change rather than on mount (H3). The visible chrome is only drawn when a message
          is present. role="alert"/assertive is reserved for error toasts. */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={toast && toast.ok ? { ...toastStyle, ...toastVEdge, ...hEdge } : srOnly}
      >
        {toast && toast.ok ? toast.msg : ""}
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        style={toast && !toast.ok ? { ...toastErrStyle, ...toastVEdge, ...hEdge } : srOnly}
      >
        {toast && !toast.ok ? toast.msg : ""}
      </div>
    </div>
  );
}

export default ClaudeUIDevkit;
