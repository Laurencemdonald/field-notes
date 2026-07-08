# Comparison View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user select exactly two references and view them side by side, read-only, to compare palette and materials by eye.

**Architecture:** Entirely client-side in `index.html`. Reuses the existing select-mode selection machinery (`selectedIds`, `selecting`, the sticky `#zineToolbar`) and the existing full-screen `#overlay` backdrop. Adds one toolbar link (`compare`, enabled only at exactly 2 selected), a second child inside the overlay (`#compare`) shown instead of the single-item `#modal`, and the render/close logic. `server.js` is untouched — `library.json` already carries every field displayed.

**Tech Stack:** Vanilla HTML/CSS/JS, no framework, no build step, no dependencies. Node `http` server (`node server.js`, port 4317). Verification is by driving the app in a browser — there is no automated test harness, and adding one would break the project's zero-dependency constraint.

**Spec:** `docs/superpowers/specs/2026-07-08-comparison-view-design.md`

---

## Testing note (read first)

This project has **no unit-test framework** and must not gain one (zero-dependency constraint). Each task's "verify" step means: run the server and drive the page in a browser, confirming the described behavior. Start the server once:

```bash
node server.js
# open http://localhost:4317
```

The app seeds a handful of demo references on first run, which is enough to exercise the comparison view (need at least 2 cards).

---

## File structure

- **Modify only:** `index.html`
  - `<style>` block — one new CSS group for the disabled toolbar link, and one for the `.compare` layout.
  - `#zineToolbar` markup — add the `compare` link.
  - `#overlay` markup — add the `#compare` child container.
  - `<script>` — `updateZineCount()` gains compare-link enable/disable; new `openCompare` / `closeCompare` / `compareColumn` / `mkCmpRow`; `comparing` flag; updated close routing (ESC, backdrop) and a defensive line in `openModal`.

No new files. `server.js` unchanged.

---

## Task 0: Isolate pending fixes (housekeeping)

The working tree currently holds uncommitted security/correctness fixes (`server.js`, `index.html`) on `main`. Get onto a branch and commit those first so the comparison-view work has a clean, separate history.

**Files:** none created; git only.

- [ ] **Step 1: Create a branch off main**

```bash
git checkout -b comparison-view
```

- [ ] **Step 2: Commit the pending fixes**

```bash
git add server.js index.html
git commit -m "Harden local server: loopback bind, CSRF guard, atomic library writes, delete confirm

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 3: Commit the design + plan docs**

```bash
git add docs/superpowers/specs/2026-07-08-comparison-view-design.md docs/superpowers/plans/2026-07-08-comparison-view.md
git commit -m "docs: comparison view spec + implementation plan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 1: Add the `compare` toolbar link and its enable/disable state

**Files:**
- Modify: `index.html` — `<style>` (add disabled-link rule), `#zineToolbar` markup, `updateZineCount()`.

- [ ] **Step 1: Add the disabled-link CSS**

Find this rule in the `<style>` block:

```css
  .zt-link:hover{color:var(--ink);}
```

Add immediately after it:

```css
  .zt-link.disabled{opacity:.4;cursor:default;pointer-events:none;text-decoration:none;}
```

- [ ] **Step 2: Add the `compare` link to the toolbar**

Find this line in the `#zineToolbar` markup:

```html
  <span class="zt-link" id="ztClear">clear</span>
```

Add immediately after it:

```html
  <span class="zt-link disabled" id="ztCompare" title="select exactly two to compare">compare</span>
```

- [ ] **Step 3: Toggle the link's enabled state in `updateZineCount()`**

Find the start of `updateZineCount()`:

```javascript
function updateZineCount(){
  const n=selectedIds.size;
  ztCreate.disabled=n===0;
```

Replace those three lines with:

```javascript
function updateZineCount(){
  const n=selectedIds.size;
  ztCreate.disabled=n===0;
  document.getElementById("ztCompare").classList.toggle("disabled", n!==2);
```

- [ ] **Step 4: Verify in the browser**

Reload `http://localhost:4317`. Click **make a zine →** to enter select mode. Confirm:
- With 0 or 1 cards selected, `compare` is dimmed (opacity ~0.4) and not clickable.
- Selecting a 2nd card un-dims `compare`.
- Selecting a 3rd card re-dims it.
Clicking `compare` does nothing yet — that's Task 3.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add compare link to select toolbar (enabled at exactly 2)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add the comparison overlay container and its styles

**Files:**
- Modify: `index.html` — `#overlay` markup, `<style>` (new `.compare` group).

- [ ] **Step 1: Add the `#compare` container inside the overlay**

Find the overlay's closing structure:

```html
      <div class="m-actions" id="mActions"></div>
    </div>
  </div>
</div>
```

That is the end of `#modal` and `#overlay`. Replace it with (adds a sibling `#compare` before `#overlay` closes):

```html
      <div class="m-actions" id="mActions"></div>
    </div>
  </div>
  <div class="compare" id="compare">
    <span class="cmp-close" id="cmpClose" title="close">×</span>
    <div class="cmp-grid" id="cmpGrid"></div>
  </div>
</div>
```

- [ ] **Step 2: Add the `.compare` CSS group**

Find this rule in the `<style>` block:

```css
  .res-note{font-family:var(--sans);font-size:10px;color:var(--gray);letter-spacing:.04em;text-transform:lowercase;}
```

Add immediately after it:

```css
  /* compare two references, side by side (read-only) */
  .compare{display:none;}
  .overlay.cmp .modal{display:none;}
  .overlay.cmp .compare{display:block;background:var(--bg);border:1px solid var(--line);max-width:1100px;width:100%;position:relative;}
  .cmp-close{position:absolute;top:14px;right:16px;font-family:var(--sans);font-size:18px;line-height:1;color:var(--gray);cursor:pointer;z-index:2;user-select:none;}
  .cmp-close:hover{color:var(--ink);}
  .cmp-grid{display:grid;grid-template-columns:1fr 1fr;}
  .cmp-col{padding:30px 28px;display:flex;flex-direction:column;border-right:1px solid var(--line);}
  .cmp-col:last-child{border-right:none;}
  .cmp-img{background:#FAFAFA;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;height:320px;}
  .cmp-img img{max-width:100%;max-height:100%;object-fit:contain;display:block;}
  .cmp-name{font-family:var(--serif);font-style:italic;font-size:22px;line-height:1.15;color:var(--ink);margin-top:18px;}
  .cmp-desc{font-family:var(--serif);font-size:15px;line-height:1.5;color:var(--ink-2);margin-top:8px;}
  .cmp-col .m-row{width:100%;}
  @media(max-width:760px){
    .cmp-grid{grid-template-columns:1fr;}
    .cmp-col{border-right:none;border-bottom:1px solid var(--line);}
    .cmp-col:last-child{border-bottom:none;}
  }
```

- [ ] **Step 3: Verify in the browser**

Reload the page. The comparison container is present but hidden (`display:none`) — the page must look **unchanged**. Confirm the normal single-photo modal still opens when you click a card (not in select mode) and closes normally. No visual regression.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add hidden compare overlay container + two-column styles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Render the two-up comparison and wire the `compare` link

**Files:**
- Modify: `index.html` — `<script>` (new functions + click handler).

- [ ] **Step 1: Add the render + open functions**

Find this comment block that begins the make-a-zine section:

```javascript
/* ---------- make a zine ---------- */
let selecting=false;
```

Insert the following **immediately before** that `/* ---------- make a zine ---------- */` line:

```javascript
/* ---------- compare two references ---------- */
let comparing=false;

// Build one read-only column for a single item, reusing the modal's row styles.
function mkCmpRow(label){
  const row=document.createElement("div"); row.className="m-row";
  const l=document.createElement("div"); l.className="m-label"; l.textContent=label;
  row.appendChild(l);
  return row;
}
function compareColumn(it){
  const col=document.createElement("div"); col.className="cmp-col";

  const imgWrap=document.createElement("div"); imgWrap.className="cmp-img";
  const img=document.createElement("img"); img.src=imgSrc(it,1200); img.alt=it.name||"";
  imgWrap.appendChild(img); col.appendChild(imgWrap);

  const name=document.createElement("div"); name.className="cmp-name"; name.textContent=it.name||"untitled";
  col.appendChild(name);
  if(it.description){ const d=document.createElement("div"); d.className="cmp-desc"; d.textContent=it.description; col.appendChild(d); }

  const palRow=mkCmpRow("palette");
  const sw=document.createElement("div"); sw.className="m-swatches";
  (it.colors||[]).forEach(c=>{
    const box=document.createElement("div"); box.style.cssText="display:flex;flex-direction:column;align-items:center;gap:5px;";
    const s=document.createElement("div"); s.className="m-sw"; s.style.background=c;
    const hex=document.createElement("div"); hex.className="m-sw-hex"; hex.textContent=c;
    box.appendChild(s); box.appendChild(hex); sw.appendChild(box);
  });
  palRow.appendChild(sw); col.appendChild(palRow);

  const matRow=mkCmpRow("materials");
  const mv=document.createElement("div"); mv.className="m-mats";
  mv.textContent=(it.materials&&it.materials.length)?it.materials.join(", "):"—";
  matRow.appendChild(mv); col.appendChild(matRow);

  const cmRow=mkCmpRow("category · mood");
  const cmv=document.createElement("div"); cmv.className="m-val";
  cmv.textContent=it.category+" · "+it.mood;
  cmRow.appendChild(cmv); col.appendChild(cmRow);

  const tdRow=mkCmpRow("trip · date");
  const tdv=document.createElement("div"); tdv.className="m-val";
  tdv.textContent=[(it.folder||"").trim(), fmtDate(it.date,true)].filter(Boolean).join(" · ")||"—";
  tdRow.appendChild(tdv); col.appendChild(tdRow);

  return col;
}
function openCompare(){
  const ids=[...selectedIds];
  if(ids.length!==2) return;
  const a=items.find(x=>x.id===ids[0]), b=items.find(x=>x.id===ids[1]);
  if(!a||!b) return;
  const g=document.getElementById("cmpGrid"); g.innerHTML="";
  g.appendChild(compareColumn(a)); g.appendChild(compareColumn(b));
  comparing=true;
  overlay.classList.add("cmp","open");
}
function closeCompare(){
  overlay.classList.remove("cmp","open");
  comparing=false;
  document.getElementById("cmpGrid").innerHTML="";
}
```

Note: this block references `overlay`, `items`, `imgSrc`, and `fmtDate`, all of which are already defined earlier in the file, and the `.m-swatches` / `.m-sw` / `.m-sw-hex` / `.m-mats` / `.m-val` / `.m-row` / `.m-label` styles that already exist for the modal.

- [ ] **Step 2: Wire the `compare` link and the ✕ button**

Find this existing handler:

```javascript
ztCreate.addEventListener("click", createZine);
```

Add immediately after it:

```javascript
document.getElementById("ztCompare").addEventListener("click", ()=>{ if(selectedIds.size===2) openCompare(); });
document.getElementById("cmpClose").addEventListener("click", closeCompare);
```

- [ ] **Step 3: Verify in the browser**

Reload. Enter select mode, select exactly 2 cards, click `compare`. Confirm:
- The overlay opens showing **two columns**, left = first-selected, right = second-selected.
- Each column shows image, italic name, description (if any), palette swatches with hex, materials, category · mood, and trip · date — with the row labels aligned across the two columns.
- There are **no** edit/delete/trip-input controls in this view.
- Clicking the ✕ closes it.

(ESC and backdrop-click may not close it correctly yet — that's Task 4.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Render two-up comparison view and open it from the compare link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Route close paths correctly and preserve select mode

Make ESC and backdrop-click close the comparison (not the modal), keep select mode active after closing a comparison, and defensively ensure the single modal never inherits the `cmp` class.

**Files:**
- Modify: `index.html` — `<script>` (`openModal`, overlay click handler, ESC handler).

- [ ] **Step 1: Defensively clear `cmp` when opening the single modal**

Find:

```javascript
function openModal(id){ activeId=id; editing=false; paintModal(); overlay.classList.add("open"); }
```

Replace with:

```javascript
function openModal(id){ activeId=id; editing=false; overlay.classList.remove("cmp"); paintModal(); overlay.classList.add("open"); }
```

- [ ] **Step 2: Route the backdrop click**

Find:

```javascript
overlay.addEventListener("click", e=>{ if(e.target===overlay) closeModal(); });
```

Replace with:

```javascript
overlay.addEventListener("click", e=>{ if(e.target!==overlay) return; if(comparing) closeCompare(); else closeModal(); });
```

- [ ] **Step 3: Route the ESC key**

Find:

```javascript
document.addEventListener("keydown", e=>{
  if(e.key!=="Escape") return;
  if(overlay.classList.contains("open")) closeModal();
  else if(selecting) exitSelect();
});
```

Replace with:

```javascript
document.addEventListener("keydown", e=>{
  if(e.key!=="Escape") return;
  if(comparing) closeCompare();
  else if(overlay.classList.contains("open")) closeModal();
  else if(selecting) exitSelect();
});
```

- [ ] **Step 4: Verify close routing + select-mode persistence**

Reload. Open a comparison (select 2 → `compare`). Then, for **each** of ✕, ESC, and clicking the dimmed backdrop:
- The comparison closes and returns to the grid.
- **Select mode is still active** (the sticky toolbar is still visible) and **both photos are still selected** (outlined, with ✓ marks).
- You can then deselect one card, select a different one, and click `compare` again to compare a new pair.
Also confirm the ESC key while comparing does **not** exit select mode in the same press (it only closes the comparison).

- [ ] **Step 5: Verify no single-modal regression**

Press ESC (or cancel) to exit select mode. Click a single card to open the normal modal. Confirm it opens correctly (image + editable name/description + trip input + edit/delete actions), and that ESC / backdrop-click / delete all still behave as before. This confirms the shared overlay wasn't broken by the `cmp` routing.

- [ ] **Step 6: Verify responsive stacking**

Narrow the browser window (or use device emulation) below ~760px wide and open a comparison. Confirm the two columns **stack into one column**, same content, no horizontal overflow.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Route ESC/backdrop close to comparison; keep select mode after closing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review (completed by plan author)

**Spec coverage:**
- Passive side-by-side, read-only → Task 3 `compareColumn` (no edit controls). ✓
- Reuse select mode; `compare` enabled only at exactly 2 → Task 1. ✓
- Reuse existing `.overlay`; new `.compare` layout → Task 2. ✓
- Panel contents (image, name, palette, materials, category·mood, trip·date) → Task 3. ✓
- Stay in select mode after closing → Task 4 (closeCompare touches neither `selecting` nor `selectedIds`; verified Step 4). ✓
- Responsive single-column stack → Task 2 CSS + Task 4 Step 6. ✓
- Zero server changes → no `server.js` task. ✓
- Verification per spec's 5 checks → distributed across Task 3 Step 3 and Task 4 Steps 4–6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type/name consistency:** `comparing`, `openCompare`, `closeCompare`, `compareColumn`, `mkCmpRow`, `#ztCompare`, `#cmpClose`, `#cmpGrid`, `#compare`, `.cmp` / `.compare` / `.cmp-*` classes used identically across Tasks 2–4. `openCompare` reads the two ids from `selectedIds` (matches spec decision to not keep a separate id list). ✓
