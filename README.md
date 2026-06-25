# claude-uidevkit

> Click an element (or drag a box) in your running app → bundle full context for Claude → fix it from Claude Code.

A dev-only, in-page overlay for **Next.js App Router** apps. When something looks
wrong in the browser, you point at it, type what you want changed, and hit send. The
overlay captures a rich context bundle — the React owner-component chain, DOM +
computed styles, recent console errors, and an in-browser screenshot — and queues it
on disk. Then you run the `/uidevkit` slash command in Claude Code and it fixes
every queued capture, citing the `file:line` it changed.

It never ships to production: the overlay is mounted behind a `NODE_ENV` guard (so
it's tree-shaken out of prod builds) and the API route 404s when
`NODE_ENV === "production"`.

## Install

In your Next.js project:

```bash
npx claude-uidevkit init
```

That one command:

- creates `app/api/claude-uidevkit/route.ts` (re-exports the capture handler)
- adds `.claude/commands/uidevkit.md` (the `/uidevkit` command)
- appends `.claude/claude-uidevkit/` to your `.gitignore`
- installs `claude-uidevkit` + `html-to-image` as devDependencies
- prints the one line to add to your root layout

Then mount the overlay in your root layout (`app/layout.tsx`):

```tsx
import { ClaudeUIDevkit } from "claude-uidevkit";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        {process.env.NODE_ENV !== "production" && <ClaudeUIDevkit />}
      </body>
    </html>
  );
}
```

That's it. Start your dev server and you'll see the 🐛 / ⬚ controls in the corner.

### `init` options

| Flag           | Effect                                                       |
| -------------- | ----------------------------------------------------------- |
| `--force`      | Overwrite an existing route file / slash command            |
| `--no-install` | Skip dependency install; print the command to run instead   |

## Usage

| Mode        | Trigger                          | What it does                                       |
| ----------- | -------------------------------- | ------------------------------------------------- |
| **Element** | 🐛 button or `⌘/Ctrl+Shift+E`    | Highlight one element, click or tap to pick it    |
| **Area**    | ⬚ button or `⌘/Ctrl+Shift+S`     | Drag (mouse or finger) a box over a region        |

After you pick, type what Claude should change and press **Send to Claude** (`⌘/Ctrl+⏎`).
Capture as many issues as you like — each is appended to the queue — then run:

```
/uidevkit
```

Claude reads each queued bundle in capture order, applies the fix, and removes the
entry. Pass extra instructions inline, e.g. `/uidevkit just tell me the files`
to report without editing.

`Esc` cancels pick mode or closes the note box.

## Configuration

The component takes optional props:

```tsx
<ClaudeUIDevkit
  position="bottom-left"                 // "bottom-right" (default) | "bottom-left" | "top-right" | "top-left"
  endpoint="/api/claude-uidevkit"        // default — match your route location if you move it
  frameworkComponentNames={["MyProvider"]} // extra wrapper names to demote in the owner chain
/>
```

- **`position`** — move the controls if they collide with an app FAB (chat widget, etc.).
- **`endpoint`** — the API route the overlay POSTs to. If you relocate the route, the
  App Router folder path is the source of truth: rename the `app/api/<name>/` folder
  (e.g. `app/api/<name>/route.ts`) and set `endpoint` to the matching `/api/<name>`
  path so the two line up.
- **`frameworkComponentNames`** — your own wrapper components to flag as framework
  (so your real components surface first in the captured owner chain).

### Customizing the route handler

The generated `route.ts` just re-exports the default handler. To customize — allow
extra dev-tunnel hosts, change the queue directory, or raise the body cap — use the
factory:

```ts
// app/api/claude-uidevkit/route.ts
import { createUIDevkitRoute } from "claude-uidevkit/server";

export const { POST } = createUIDevkitRoute({
  extraHosts: [/\.trycloudflare\.com$/], // beyond the built-in loopback + ngrok hosts
  // queueDir, maxBodyBytes also available
});
```

## How it works

- **Capture (browser).** `<ClaudeUIDevkit/>` walks React fiber internals
  (`_debugOwner`) to recover the owner-component chain, snapshots the DOM with
  `html-to-image` (no "share this tab" prompt), and POSTs a JSON bundle to the route.
- **Queue (disk).** The route writes each capture to its own folder under
  `.claude/claude-uidevkit/queue/<id>/` — a `meta.json` plus `screenshot.png` (and a
  cropped `region.png` for area captures).
- **Fix (Claude Code).** The `/uidevkit` command reads the queue in order, maps
  each capture to source files, applies the change, and deletes the entry.

## Mobile / tunnel capture

The route accepts requests from `localhost`, loopback IPs, and `*.ngrok(-free).(app|io)`
out of the box — so you can run your dev server through an ngrok tunnel and capture
straight from your phone. Add more hosts via `createUIDevkitRoute({ extraHosts })`.

Both capture modes work with touch: the overlay uses Pointer Events, so on a phone you
**tap** an element to pick it (Element mode) or **drag** a box over a region (Area mode),
the same as with a mouse on desktop.

## Requirements

- Next.js App Router (`>=14`)
- React `>=18` (the owner-chain walk is richest on React 19)

### Optional

- `html-to-image` — enables the in-browser screenshot. It's an **optional** peer
  dependency (`init` installs it for you). Captures still work without it — you just
  get the context bundle (owner chain, DOM, styles, console) with no `screenshot.png`.

## Caveats

- **WebGL / `<canvas>` content renders blank** in the screenshot — `html-to-image`
  can't read back GPU pixels without `preserveDrawingBuffer`. The DOM context is still
  captured.
- Dev-only by design. It is never mounted or served in production builds.

## Security

Defense in depth so a misconfigured preview can't become an unauthenticated
file-write sink:

1. The overlay is mounted behind `process.env.NODE_ENV !== "production"` (statically
   tree-shaken out of prod).
2. The route returns `404` when `NODE_ENV === "production"`.
3. The route rejects any request whose `Host` isn't loopback / an allow-listed tunnel.
4. The route rejects cross-origin writes: it requires `Sec-Fetch-Site: same-origin`
   (falling back to an `Origin`/`Host` host match), so another site you happen to have
   open can't drive-by POST captures into your queue.
5. Request bodies are capped in bytes **before** parsing (25 MB by default), embedded
   images are validated by magic bytes and capped separately, and the queue is bounded
   so a flood can't fill the disk.

## License

MIT © Luis Fernando Lara Saldarriaga
