---
description: Process the queued claude-uidevkit captures (clicked element + note + screenshot + context), fix each, then remove it
---

The user flagged one or more spots in the running app with the in-page **claude-uidevkit**
overlay — either by clicking a single element or by dragging a box over an area. Each
capture is a context bundle written to its own folder under `.claude/claude-uidevkit/queue/<id>/`
(containing `meta.json`, a `screenshot.png`, and — for area captures — a cropped
`region.png`). Fix every queued capture in order, then delete each as you finish it.

Do this:

1. **List the queue.** Read the subdirectories of `.claude/claude-uidevkit/queue/` and sort them
   ascending by folder name (the name is a millisecond timestamp, so this is capture
   order). If the queue is empty or missing, tell the user to capture first: use the
   🐛 Element button (⌘/Ctrl+Shift+E) to pick one element, or the ⬚ Area button
   (⌘/Ctrl+Shift+S) to drag a box over a region, type the change, **Send to Claude** —
   repeat for as many issues as they want — then re-run `/uidevkit`.

2. **For each entry, in order:**
   a. Read `<id>/meta.json`. The **`instruction`** field is what the user typed into the
      note box — treat it as the primary directive for that entry (it may be null if they
      captured without a note). Check **`mode`**: `"element"` (a single clicked element) or
      `"region"` (a dragged box over an area). Read the image(s) to see the exact state
      they saw.
   b. **Locate the source** using the bundle:

      **If `mode` is `"element"` (or absent):** read `<id>/screenshot.png`, then use, in
      priority order:
      - `componentChain` — React owner components, nearest first. Entries with
        `framework: false` are app components; grep the repo for the first one to find its
        source file (e.g. a `Card` entry → search for where `Card` is defined, such as
        `components/Card.tsx`).
      - `target` — the clicked DOM node: `tag`, `classes`, `text`, `selector`,
        `outerHTML`, computed `styles`, `rect`. Use `text`/`classes` to pinpoint the
        exact JSX within the file.
      - `renderStack` — raw React render frames (bundled URLs); secondary hint only.

      **If `mode` is `"region"`:** read `<id>/region.png` (a crop of just the selected
      area) and `<id>/screenshot.png` (the full page with the area outlined in amber).
      Then use:
      - `elementsInRegion` — the deduped components/elements whose boxes intersect the
        selection, each with its `componentChain` (grep the first `framework:false` name)
        and `selector`. These are the files to change for this area.
      - `region` — the box's pixel coords `{x,y,w,h}`, for cross-referencing the images.
      The instruction may span several of those components — apply it across them.

      For both modes also consider:
      - `recentConsole` — console errors/warnings captured before the capture; often the
        real error.
      - `url` / `path` — the route. This is a Next.js App Router app: map the URL path to
        the matching file under `app/` (or `src/app/`), honoring dynamic segments — e.g.
        `/` → `app/page.tsx`, `/blog/123` → `app/blog/[id]/page.tsx`,
        `/dashboard/settings` → `app/dashboard/settings/page.tsx`.
   c. **Apply the change**, citing the `file:line` you edited.
   d. **Delete that entry's folder** (`rm -rf .claude/claude-uidevkit/queue/<id>`) once its fix is
      applied — but ONLY if it succeeded. If you couldn't fix one (ambiguous, blocked,
      needs the user's input), LEAVE its folder in place and say why, so it stays queued
      for a follow-up.

3. **Summarize** at the end: one line per entry — the instruction, the `file:line` you
   changed, and ✅ done (deleted) or ⏸ left queued (why). Disjoint files can be edited in
   parallel; if two entries touch the same file, apply them sequentially to avoid
   conflicts.

Read `$ARGUMENTS` for any extra instruction the user typed after `/uidevkit` (e.g.
`/uidevkit just tell me the files`, in which case don't edit or delete — only report).

Note: `.claude/claude-uidevkit/` is git-ignored and dev-only; the `/api/claude-uidevkit` route and the
`<ClaudeUIDevkit/>` overlay never ship to production.
