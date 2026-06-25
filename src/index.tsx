"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ClaudeUIDevkit — in-page "click an element → bundle full context for Claude" overlay.
// DEV ONLY. Mount it from app/layout.tsx behind a NODE_ENV guard so it is fully
// tree-shaken out of production builds.
//
// Two capture modes:
//   • Element (🐛 button or ⌘/Ctrl+Shift+E) — hover-highlight one element, click it.
//   • Area    (⬚ button or ⌘/Ctrl+Shift+S) — drag a box over a region of the screen.
// Either way you then type a note and send. The bundle carries your note, the URL,
// the React owner-component chain, DOM/selector + styles (element) or the box coords
// + the components inside it (region), recent console errors, and an in-browser DOM
// screenshot (region mode adds a cropped close-up). It's POSTed to the API route
// (default /api/claude-uidevkit), which appends it as a new entry under
// `.claude/claude-uidevkit/queue/`. Capture as many as you like, then run
// `/claude-uidevkit` in Claude Code to fix them all (each entry deleted as it's handled).
//
// Why owner chain, not file:line — React 19 removed fiber `_debugSource`. The
// `_debugOwner` walk still yields real component names (e.g. "Topbar"), which is a
// one-grep lookup to the source file. Raw `_debugStack` frames (bundled URLs) are
// captured too as a secondary hint.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

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
let consoleHooked = false;

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

function hookConsole() {
  if (consoleHooked || typeof window === "undefined") return;
  consoleHooked = true;
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      push(level, fmt(args));
      orig(...args);
    };
  }
  window.addEventListener("error", (e) =>
    push("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    push("error", `unhandledrejection: ${fmt([e.reason])}`),
  );
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
// prioritizes the app components. Consumers can extend this via the
// `frameworkComponentNames` prop.
const FRAMEWORK_NAMES = new Set([
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
]);

function ownerChain(el: Element): { name: string; framework: boolean }[] {
  const out: { name: string; framework: boolean }[] = [];
  let node = getFiber(el);
  let guard = 0;
  while (node && guard++ < 80) {
    const n = fiberName(node);
    if (n && /^[A-Z]/.test(n) && !out.some((o) => o.name === n)) {
      out.push({ name: n, framework: FRAMEWORK_NAMES.has(n) });
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
function cssSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
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

// Collect the distinct app components visible inside the selected box, so Claude can
// jump straight to the source files for that area. We sample a grid of points across
// the region and take the topmost element at each (document.elementFromPoint) — this
// captures what's actually visible (text, buttons, cards) without getting fooled by
// full-bleed background images or page-level wrappers. Deduped by component, capped.
function collectElementsInRegion(region: Region) {
  const out: {
    tag: string;
    text: string | null;
    selector: string;
    componentChain: { name: string; framework: boolean }[];
  }[] = [];
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

      const chain = ownerChain(el);
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
// full image with that box outlined. Region coords are viewport-space; we normalize
// by document.body's rect so the mapping holds regardless of page scroll.
async function renderRegionImages(
  fullDataUrl: string,
  region: Region,
): Promise<{ outlined: string; cropped: string | null }> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = fullDataUrl;
  });
  const bodyRect = document.body.getBoundingClientRect();
  const scaleX = img.naturalWidth / bodyRect.width;
  const scaleY = img.naturalHeight / bodyRect.height;

  let sx = (region.left - bodyRect.left) * scaleX;
  let sy = (region.top - bodyRect.top) * scaleY;
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
  const [frozen, setFrozen] = useState<string | null>(null); // freeze-frame backdrop for region mode
  const [note, setNote] = useState("");
  const [capturing, setCapturing] = useState(false); // hide overlay UI for the screenshot
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const active = mode === "element"; // derived: element-pick mode is on
  const noteRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => hookConsole(), []);

  // Merge any consumer-supplied framework wrapper names into the shared set.
  useEffect(() => {
    frameworkComponentNames?.forEach((n) => FRAMEWORK_NAMES.add(n));
  }, [frameworkComponentNames]);

  // Focus the note box as soon as an element or region is picked.
  useEffect(() => {
    if (selected || region) noteRef.current?.focus();
  }, [selected, region]);

  const flash = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    window.setTimeout(() => setToast(null), ok ? 3500 : 6000);
  }, []);

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
  // Trigger region mode with ⌘/Ctrl+Shift+S (keyboard) so the mouse stays parked on
  // the hovered element while the snapshot is taken.
  useEffect(() => {
    if (mode !== "region") return;
    let cancelled = false;
    (async () => {
      setFrozen(null); // clear any stale frame (inside async, not the effect body)
      const f = await grabScreenshot();
      if (!cancelled) setFrozen(f);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, grabScreenshot]);

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
        componentChain: ownerChain(el),
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
            `Captured ${comp}${screenshot ? "" : " (no screenshot)"} → ${n} queued. Run /claude-uidevkit`,
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
      }
    },
    [grabScreenshot, flash, endpoint],
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
          const r = await renderRegionImages(full, reg);
          outlined = r.outlined;
          regionImage = r.cropped;
        } catch {
          /* keep the un-annotated full image as a fallback */
        }
      }

      const elementsInRegion = collectElementsInRegion(reg);
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
          flash(`Captured area (${elementsInRegion.length} comps) → ${n} queued. Run /claude-uidevkit`);
        } else {
          flash(`Save failed: ${json.error ?? "unknown"}`, false);
        }
      } catch (err) {
        flash(`POST failed: ${err instanceof Error ? err.message : "?"}`, false);
      } finally {
        setCapturing(false);
        setRegion(null);
        setFrozen(null);
        setNote("");
      }
    },
    [grabScreenshot, flash, frozen, endpoint],
  );

  // ── Pick-mode pointer + keyboard wiring ────────────────────────────────────
  useEffect(() => {
    const toggle = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setMode((m) => (m === "element" ? "off" : "element"));
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setMode((m) => (m === "region" ? "off" : "region"));
      }
      if (e.key === "Escape") {
        setMode("off");
        setSelected(null);
        setRegion(null);
        setDrag(null);
        setFrozen(null);
        setNote("");
      }
    };
    window.addEventListener("keydown", toggle, true);
    return () => window.removeEventListener("keydown", toggle, true);
  }, []);

  useEffect(() => {
    // When inactive we attach no listeners; the highlight box is gated on `active`
    // in render, so any stale `hovered` simply isn't drawn (no setState needed here).
    if (!active) return;
    const isOurs = (t: EventTarget | null) =>
      t instanceof Element && t.closest("[data-claude-uidevkit]") !== null;

    const onMove = (e: MouseEvent) => {
      if (isOurs(e.target)) return;
      if (e.target instanceof Element) setHovered(e.target);
    };
    const onClick = (e: MouseEvent) => {
      if (isOurs(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.target instanceof Element) {
        // Freeze the pick and open the note input; capture happens on submit.
        setSelected(e.target);
        setMode("off");
      }
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.body.style.cursor = "crosshair";
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.body.style.cursor = "";
    };
  }, [active]);

  const hoverRect = hovered?.getBoundingClientRect();
  const hoverName = hovered ? ownerChain(hovered).find((c) => !c.framework)?.name : null;

  const selRect = selected?.getBoundingClientRect();
  const selName = selected ? ownerChain(selected).find((c) => !c.framework)?.name : null;

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

  // Anchor the note panel just below the pending rect, clamped to the viewport.
  const PANEL_W = 340;
  const panelPos = pendingRect
    ? {
        left: Math.min(Math.max(8, pendingRect.left), (typeof window !== "undefined" ? innerWidth : 1200) - PANEL_W - 8),
        top: Math.min(pendingRect.bottom + 8, (typeof window !== "undefined" ? innerHeight : 800) - 200),
      }
    : { left: 8, top: 8 };

  const submitPending = () => {
    if (selected) capture(selected, note);
    else if (region) captureRegion(region, note);
  };
  const cancelPending = () => {
    setMode("off");
    setSelected(null);
    setRegion(null);
    setDrag(null);
    setFrozen(null);
    setNote("");
  };

  // ── Corner placement for the floating controls + toast ─────────────────────
  const isBottom = position.startsWith("bottom");
  const isRight = position.endsWith("right");
  const vEdge: CSSProperties = isBottom ? { bottom: 16 } : { top: 16 };
  const hEdge: CSSProperties = isRight ? { right: 16 } : { left: 16 };
  const controlsAlign = isRight ? "flex-end" : "flex-start";
  const toastVEdge: CSSProperties = isBottom ? { bottom: 60 } : { top: 60 };

  const pillBase: CSSProperties = {
    padding: "8px 12px",
    borderRadius: 999,
    border: "none",
    cursor: "pointer",
    font: "600 12px ui-monospace, monospace",
    boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
    backdropFilter: "blur(4px)",
  };
  const pillIdle: CSSProperties = { ...pillBase, color: "#fde68a", background: "rgba(28,25,23,0.92)" };
  const pillActive: CSSProperties = { ...pillBase, color: "#1a1205", background: "#f59e0b" };

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
      {/* Highlight box */}
      {active && hoverRect && !capturing && (
        <div
          style={{
            position: "fixed",
            left: hoverRect.x,
            top: hoverRect.y,
            width: hoverRect.width,
            height: hoverRect.height,
            border: "2px solid #f59e0b",
            background: "rgba(245,158,11,0.12)",
            borderRadius: 4,
            pointerEvents: "none",
            zIndex: 2147483646,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: -22,
              left: 0,
              background: "#f59e0b",
              color: "#1a1205",
              font: "600 11px ui-monospace, monospace",
              padding: "2px 6px",
              borderRadius: 3,
              whiteSpace: "nowrap",
            }}
          >
            {hovered?.tagName.toLowerCase()}
            {hoverName ? ` · ${hoverName}` : ""}
          </span>
        </div>
      )}

      {/* Frozen highlight on the picked element / region while the note box is open */}
      {pendingRect && !capturing && (
        <div
          style={{
            position: "fixed",
            left: pendingRect.left,
            top: pendingRect.top,
            width: pendingRect.width,
            height: pendingRect.height,
            border: "2px solid #f59e0b",
            background: "rgba(245,158,11,0.12)",
            borderRadius: 4,
            pointerEvents: "none",
            zIndex: 2147483646,
          }}
        />
      )}

      {/* Freeze-frame backdrop — the page snapshot taken when region mode began, so
          any on-hover state stays visible while you draw + gets captured. Offset by
          scroll so it aligns with the current viewport. */}
      {mode === "region" && frozen && !capturing && (
        // eslint-disable-next-line @next/next/no-img-element -- dev-only base64 freeze-frame, not an optimizable asset
        <img
          src={frozen}
          alt=""
          style={{
            position: "fixed",
            top: -window.scrollY,
            left: -window.scrollX,
            width: "100vw",
            height: "auto",
            pointerEvents: "none",
            zIndex: 2147483645,
          }}
        />
      )}

      {/* "Freezing…" hint while the snapshot is taken (pointer-events:none so it does
          NOT steal the :hover we're trying to capture). */}
      {mode === "region" && !frozen && !capturing && (
        <div
          style={{
            position: "fixed",
            top: 16,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2147483647,
            padding: "8px 14px",
            borderRadius: 999,
            pointerEvents: "none",
            font: "600 12px ui-monospace, monospace",
            color: "#1a1205",
            background: "#f59e0b",
            boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
          }}
        >
          ❄ Freezing page… keep the mouse still
        </div>
      )}

      {/* Region drawing layer — owns the drag so it never clicks/selects the page.
          Only mounts AFTER the freeze-frame is ready (else it'd steal the :hover). */}
      {mode === "region" && frozen && !region && !capturing && (
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setDrag({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY });
          }}
          onMouseMove={(e) => {
            if (drag) setDrag({ ...drag, x1: e.clientX, y1: e.clientY });
          }}
          onMouseUp={() => {
            if (dragRect && dragRect.width > 6 && dragRect.height > 6) {
              setRegion({ ...dragRect });
            }
            setDrag(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            cursor: "crosshair",
            zIndex: 2147483646,
            // Subtle dim so the page is clearly in "select" mode.
            background: drag ? "transparent" : "rgba(0,0,0,0.04)",
          }}
        >
          {dragRect && (
            <div
              style={{
                position: "fixed",
                left: dragRect.left,
                top: dragRect.top,
                width: dragRect.width,
                height: dragRect.height,
                border: "2px solid #f59e0b",
                background: "rgba(245,158,11,0.12)",
                boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      )}

      {/* Note input — type the change you want Claude to make, then send */}
      {(selected || region) && !capturing && (
        <div
          style={{
            position: "fixed",
            left: panelPos.left,
            top: panelPos.top,
            width: PANEL_W,
            zIndex: 2147483647,
            background: "rgba(28,25,23,0.97)",
            border: "1px solid #f59e0b",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
            backdropFilter: "blur(6px)",
            color: "#fde68a",
            font: "500 12px ui-monospace, monospace",
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
              if (e.key === "Escape") {
                e.preventDefault();
                cancelPending();
              }
            }}
            placeholder="What should Claude change here? (e.g. this button is misaligned on mobile)"
            rows={3}
            style={{
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
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={cancelPending}
              style={{
                padding: "6px 10px",
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
                padding: "6px 12px",
                borderRadius: 6,
                border: "none",
                background: "#f59e0b",
                color: "#1a1205",
                cursor: "pointer",
                font: "700 12px ui-monospace, monospace",
              }}
            >
              Send to Claude ⌘⏎
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
            zIndex: 2147483647,
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
                style={pillIdle}
              >
                🐛 Element <kbd style={kbdStyle}>{shortcutMod}⇧E</kbd>
              </button>
              <button
                type="button"
                onClick={() => setMode("region")}
                title="Drag a box over an area (⌘/Ctrl+Shift+S)"
                style={pillIdle}
              >
                ⬚ Area <kbd style={kbdStyle}>{shortcutMod}⇧S</kbd>
              </button>
            </>
          )}
          {mode === "element" && (
            <button type="button" onClick={() => setMode("off")} style={pillActive}>
              ● picking element — Esc
            </button>
          )}
          {mode === "region" && (
            <button type="button" onClick={() => setMode("off")} style={pillActive}>
              ● drag to select — Esc
            </button>
          )}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: "fixed",
            ...toastVEdge,
            ...hEdge,
            zIndex: 2147483647,
            maxWidth: 320,
            padding: "10px 14px",
            borderRadius: 8,
            font: "500 12px ui-monospace, monospace",
            color: toast.ok ? "#dcfce7" : "#fee2e2",
            background: toast.ok ? "rgba(22,101,52,0.95)" : "rgba(127,29,29,0.95)",
            boxShadow: "0 4px 14px rgba(0,0,0,0.4)",
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

export default ClaudeUIDevkit;
