# Comparison view — design

**Date:** 2026-07-08
**Backlog item:** author's "what i'd do next" #5 — *"let two photos sit side by side to compare materials directly"* (review report §3.5 / §6 #4).

## Purpose

Let a designer put two references side by side and compare them by eye — image,
palette, and materials aligned in the same rows. This is a *looking* tool, not an
editing or analysis tool.

## Decisions (locked)

- **Passive side-by-side.** No diff computation, no highlighting of shared/unique
  materials or colours. The eye does the comparing. (Chosen over "highlight
  overlaps" and "full diff summary".)
- **Reuse select mode.** Entry is a new `compare` link in the existing zine
  selection toolbar, enabled only when *exactly 2* cards are selected. No new
  top-level button, no separate selection flow.
- **Read-only panels.** No edit / delete / trip-assignment controls inside the
  comparison — it shows the same read content as the single-photo modal, minus
  the editable pieces.
- **Stay in select mode after closing.** Closing the comparison returns to the
  grid with both photos still selected, so the user can deselect one, pick a
  different second photo, and compare again.
- **Zero server changes.** `library.json` already carries name, palette,
  materials, category, mood, folder, and date. `server.js` is untouched.

## Behaviour

### Entry & selection
- The existing select mode (triggered by "make a zine →") already tracks
  `selectedIds` and shows a sticky toolbar.
- Add one link to that toolbar: **`compare`**.
  - Disabled (same visual treatment as the disabled `create zine →` button) unless
    `selectedIds.size === 2`.
  - Clicking it opens the comparison view for the two selected items.
- No change to how cards are selected, to multi-select, or to the zine flow. A
  user can still select many cards for a zine; `compare` simply stays disabled
  until the count is exactly 2.

### Render surface
- Reuse the existing `.overlay` element (the dimmed full-screen backdrop used by
  the single-photo modal) so open/close, ESC, and click-outside-to-close come for
  free.
- Introduce a new layout container (`.compare`) shown inside the overlay instead
  of the single `.modal`. The overlay hosts *either* the single-item modal *or*
  the comparison layout, depending on which was opened.

### Panel contents (per photo, read-only)
Ordered by selection order (first-selected on the left):
1. Image (contained, same downscaled `/library-print/` source the modal uses).
2. `name` (italic serif, as on the card/modal).
3. `palette` — swatches with hex labels.
4. `materials` — comma-joined, or "—" when empty.
5. `category · mood`.
6. `trip · date` — `folder` and formatted date, or "—" when absent.

Rows are laid out so the two panels' equivalent rows sit at the same vertical
position for left-to-right comparison.

### Exit
- ✕ control, ESC, and click-on-backdrop all close the comparison.
- On close: overlay hides; `selecting` stays true and both items stay in
  `selectedIds` (grid still shows them selected).

### Responsive
- Wide viewport: two panels side by side.
- Narrow viewport (PWA / phone): panels stack into a single column, same content.

## Components touched (all in `index.html`)

- **Toolbar markup:** add the `compare` link near `create zine →` /
  `cancel`.
- **State:** reuse `selectedIds` / `selecting`. Add one flag, `comparing`
  (boolean), so the shared overlay's close paths know whether a single modal or a
  comparison is open. The two compared ids are read from `selectedIds` at open
  time (exactly 2 by the enable rule), so no separate id list is needed.
- **`updateZineCount()` (or a sibling):** also toggle the `compare` link's
  enabled state based on `selectedIds.size === 2`.
- **New `openCompare()` / `renderCompare()`:** build the two-panel DOM into the
  overlay and open it.
- **Close handling:** the existing overlay close paths (ESC handler,
  backdrop-click, `closeModal`) must route correctly whether a single modal or a
  comparison is open — closing a comparison must NOT exit select mode.
- **CSS:** one new `.compare` block (two-column grid; single column under a
  narrow-viewport media query); reuse existing swatch / label / value styles
  where possible.

## Non-goals (YAGNI)

- No diff/highlight/summary computation.
- No editing, deleting, or trip assignment from the comparison view.
- No comparing more than two photos.
- No new server endpoints or `library.json` changes.
- No new print/zine format.

## Testing / verification

No automated test harness exists in this zero-dependency project; verify by
driving the running app:
1. Enter select mode; confirm `compare` is disabled at 0 and 1 selected, enabled
   at exactly 2, disabled again at 3+.
2. Select 2, click `compare`; confirm both photos render with aligned
   image/name/palette/materials/category·mood/trip·date, read-only (no edit or
   delete controls).
3. Close via ✕, ESC, and backdrop click; each returns to the grid with both
   photos still selected and select mode still active.
4. Narrow the viewport; confirm panels stack to one column.
5. Confirm the single-photo modal still opens and closes normally (no regression
   from sharing the overlay).
