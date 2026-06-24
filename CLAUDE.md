# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Field Notes is a local-only reference notebook for designers: drop in travel photos, and the app names each one, samples its palette, tags materials, and files it by trip (from EXIF GPS). Everything stays on disk — no account, no cloud upload.

## Running

```bash
node server.js                                 # serves http://localhost:4317
PORT=5000 node server.js                       # different port
FIELD_NOTES_MODEL=claude-sonnet-4-6 node server.js   # pin a model (default: claude-haiku-4-5)
CLAUDE_BIN=/full/path/to/claude node server.js # if `claude` isn't auto-found
```

There is **no build step, no test suite, no linter, and no `node_modules`** — this is a deliberately zero-dependency app (Node standard library only). "Develop" = edit `server.js` / `index.html` and restart the server. The HTML is served `no-cache`, so a browser refresh picks up frontend edits without a restart; **server-side changes require restarting `node server.js`**.

## Hard constraints (do not break these)

These invariants define the project; preserve them unless explicitly asked otherwise:

- **Zero dependencies.** `server.js` may only `require` Node built-ins (`http`, `fs`, `path`, `child_process`, `crypto`). Never add a package or introduce `package.json`/`node_modules`.
- **One-file frontend.** The entire UI is `index.html` in vanilla JS/CSS — no framework, no bundler, no import of external scripts at runtime (fonts are self-hosted under `fonts/`).
- **macOS-only by design.** Image work shells out to built-in `sips` (HEIC→JPEG + downscale) and `mdls` (EXIF fallback). ImageMagick (`magick`/`convert`) is an *optional* enhancement for palette + perceptual hash; code must degrade gracefully when it's absent (see the `MAGICK_BIN === ""` paths).
- **Persistence is plain files.** Metadata in `library.json` (human-readable, hand-editable), full-res originals in `library/`. No database, no localStorage. The data model in `library.json` *is* the UI model — a record's fields render directly.

## Architecture

**Two files do everything:** `server.js` (the entire backend) and `index.html` (the entire frontend). They talk over a small JSON API.

### The add pipeline (`POST /api/add` in server.js)

This is the core flow and the most intricate part. The browser sends a data-URL of the original bytes; the server then, in order:
1. **Dedup** — md5 hash of bytes; rejects byte-identical re-imports (against `library.json`) and concurrent double-fires (the in-memory `inFlight` set, since the browser drop handler can fire twice before either is saved).
2. **Store display original** — HEIC is converted to JPEG via `sips`; everything else keeps its original bytes in `library/`.
3. **Downscale for analysis** — a ≤1024px JPEG copy in `.cache/` is what gets sent to Claude (cheaper/faster); the full-res original is never sent.
4. **Analyze** — `analyzeFile` → `runClaudeCLI` (preferred) or `runAPIFromFile` (fallback). Returns the structured record (name, description, category, mood, colors, materials), run through `normalize()` which clamps category/mood to fixed vocabularies and pads colors to 4.
5. **Real palette** — `extractPalette` (ImageMagick histogram) *overrides* the model's guessed hex colors when available, because sampled pixels beat guessed values.
6. **Perceptual hash** (`perceptualHash`, dHash) for near-duplicate clustering in the UI.
7. **Trip + date** — `detectTripAndDate` reads EXIF (`exifFromJpeg` parses TIFF/APP1 bytes directly — does *not* rely on Spotlight, which won't have indexed a just-written file; `mdlsMeta` is the fallback for PNG/WEBP), then `reverseGeocode` turns GPS into a city name (Nominatim, cached on disk in `.cache/geo.json`, ≤1 req/sec).
8. **Persist** — replaces any record with the same `id` (so retries don't duplicate) and **preserves manual edits** (`folder`/`date`/`event` set by hand are never clobbered by auto-detection).

### Image analysis — two backends

`runClaudeCLI` shells out to the local `claude` CLI in headless mode (`-p ... --output-format json --allowedTools Read`), using the user's Claude Code login — **no API key**. `runAPIFromFile` (raw Anthropic API) is used **only** when the CLI isn't found *and* `ANTHROPIC_API_KEY` is set. The `SYSTEM_PROMPT` constant defines the exact output shape and is tuned for short evocative names + a constrained one-word material vocabulary; changing it changes every record's quality. Binary resolution (`CLAUDE_BIN`, `MAGICK_BIN`) searches a hardcoded `EXTRA_PATH` so the server still works under a bare launchd PATH (macOS login auto-start).

### The zine maker

Selected cards lay out as a printable zine. The imposition (PocketMod 8-panel single-sheet that folds with one cut, or saddle-stitch booklet) is built **client-side in `index.html`**, then POSTed to `/api/zine`, which stashes the HTML in-memory (`zineStore`, last 20) and returns an id. It's served back at a real `/zine/<id>` URL because printing from a real page is reliable across browsers; `/api/open` can launch it in a chromeless Chrome app window. The fold-order math is the one place where "looks right" and "is right" diverge — verify with page numbers.

### Frontend (`index.html`)

Loads `/api/library` into an in-memory `items` array and renders a card grid. Major regions, roughly in file order: filter/sort state + `matches()`, near-duplicate clustering (`hamming`/`dupClusters`), color-family bucketing for the color filter, server-call wrappers (`apiAdd`/`apiEdit`/`apiDelete`), rendering (`render`, `cardEl`, folder/event/trip-strip/filter renderers), and the drop-zone ingest path. Cards request downscaled images via `/library-print/<file>?w=N` (cached per width in `.cache/`), never the full-res original.

## Seeding & gitignored state

A fresh clone has no `library.json`; on first run the server seeds it from `samples/` so the grid isn't empty. `library/`, `library.json`, and `.cache/` are gitignored and auto-created — they hold the user's actual collection and scratch, so don't commit them and don't assume they exist when reading code.

## Working conventions

Defaults so you can act without checking in:

- **Just do it within the constraints above.** Don't ask permission for routine work that respects the zero-dependency / one-file / files-as-database / macOS invariants. Stop and ask only when a request would require breaking one of them (e.g. "this needs a library") — surface the conflict and the cheapest std-lib alternative.
- **Reach for a dependency = stop.** If a task seems to want a package, that's a signal you're solving it the wrong way here. Find the `sips`/`mdls`/ImageMagick/std-lib path instead, or flag it.
- **New external-tool calls must degrade, not throw.** Match the existing pattern: resolve the binary through `EXTRA_PATH`, wrap the spawn so a missing tool resolves to a safe fallback (`""`, `[]`, original file) rather than failing the request. ImageMagick and the API key are optional; the app must still run without them.
- **Never clobber user data.** Auto-detected fields yield to manual edits (see the `prev`-preservation logic in `/api/add`). When touching persistence, preserve `folder`/`event`/`date` that a user set by hand, and keep `library.json` valid, pretty-printed JSON.

### Verifying changes (there is no test suite)

Run the thing and observe — don't assert it works. The loop:

```bash
node server.js                                    # restart after ANY server.js edit
curl -s localhost:4317/api/library | python3 -m json.tool | head   # library renders + valid JSON
curl -s "localhost:4317/library-print/<file>?w=400" -o /tmp/t.jpg  # sips downscale path
python3 -m json.tool library.json >/dev/null && echo OK            # data file still valid
```

- **Backend change:** restart, then curl the affected endpoint and confirm the response shape and that `library.json` is unchanged-or-correctly-changed.
- **Frontend change:** just refresh the browser (`index.html` is served `no-cache`) — no restart needed.
- **Add-pipeline change:** the honest test is dropping a real photo through the UI, since `POST /api/add` invokes the model and runs the full sips/EXIF/geocode chain (slow, ~seconds). Don't claim the pipeline works off a code read alone.

### Matching the code style

`server.js` and `index.html` are terse on purpose. Match it: compact helpers, single-letter locals in tight loops, and comments that explain **why** (the non-obvious constraint or failure mode being guarded against), not what the line does. New machine-specific behavior gets an env-var override (cf. `PORT`, `FIELD_NOTES_MODEL`, `CLAUDE_BIN`, `MAGICK_BIN`).

### Privacy (this fork is public)

The `SP00KYCHIEF/field-notes` fork is **public**, so anything that gets pushed — commit messages, PR titles/bodies, code comments, branch names — is world-readable.

- **Refer to the maintainer only as the GitHub handle `SP00KYCHIEF`** in anything publicly visible. Never put a real name, email address, or other personal identifier into commits, PRs, comments, or committed files.
- **Never commit personal data.** The user's actual photos and metadata live in `library/`, `library.json`, and `.cache/`, which are gitignored — keep it that way. Don't `git add -f` anything under those paths, don't relax those `.gitignore` rules, and don't paste real EXIF/location/library contents into commit messages or PR descriptions.
- Keep examples and test fixtures to the bundled `samples/` set, never the user's own library.

### Git & commits

The history follows a consistent shape — match it rather than committing straight to `main`:

- **One feature branch per change**, kebab-case named after the feature (`dup-filter`, `event-tag`, `batch-import`, `trip-palette-strip`). Land via a PR merged into `main`; don't push commits directly to `main`.
- **Commit subject:** `Feature name — short description`, e.g. `Duplicate filter — recognize near-duplicate / burst shots`. Sentence case, em-dash, no trailing period.
- **Commit body:** lead with *why* the change exists / what problem it solves, then a short bulleted list of what changed (split `server:` vs `client:` when both move), then a **`Verified:`** line stating the concrete behavior you observed (actual numbers/output, not "tests pass" — there are none). Add `Closes #N` when it resolves an issue.
- Keep the existing `Co-Authored-By:` and `Claude-Session:` trailers.
- **Auto-committing is fine** — no need to ask before committing routine work. Small docs-only changes can go straight to `main`; keep the branch-per-feature flow for actual code changes.
