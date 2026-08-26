// Field Notes — local server (zero dependencies, Node 18+)
//
//   node server.js
//   open http://localhost:4317
//
// Image analysis runs through your installed `claude` CLI (Claude Code) using
// your existing login — NO API key required. If you'd rather use a raw API key,
// set ANTHROPIC_API_KEY and it'll use that instead.
//
// Persists metadata to ./library.json and full-res images to ./library/

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const crypto = require("crypto");

// md5 of a buffer, used to detect re-imported (byte-identical) photos
function bufHash(buf) { return crypto.createHash("md5").update(buf).digest("hex"); }

// Hashes currently being analysed. The browser can fire a drop twice (or send the
// same photo from two ingests at once); those land here before either is saved, so
// a library-only check would miss them. We hold the hash until the response closes.
const inFlight = new Set();

// Load a local .env file if present (KEY=VALUE per line) so newcomers can just
// paste their key into .env. Zero dependencies — a tiny parser, not dotenv. Real
// environment variables always win over .env.
(function loadDotEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    for (let line of txt.split("\n")) {
      line = line.trim();
      if (!line || line[0] === "#") continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { /* no .env — that's fine */ }
})();

const PORT = process.env.PORT || 4317;
const ROOT = __dirname;
const LIB_DIR = path.join(ROOT, "library");
const CACHE_DIR = path.join(ROOT, ".cache");
const LIB_JSON = path.join(ROOT, "library.json");
const API_KEY = process.env.ANTHROPIC_API_KEY || "";          // optional fallback
const MODEL = process.env.FIELD_NOTES_MODEL || "";            // optional override

// Resolve the `claude` CLI to an absolute path. When the server is auto-started
// at login (launchd on macOS, Task Scheduler on Windows), PATH is bare and a
// plain "claude" can't be found — so we search the usual install spots and fall
// back to a richer PATH at spawn.
const _isWindows = process.platform === "win32";
const _homeDir = os.homedir();
const _claudeNames = _isWindows ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
const _claudeFallback = _isWindows ? "claude.cmd" : "claude";
const EXTRA_PATH = (_isWindows
  ? [
      path.join(_homeDir, "AppData", "Roaming", "npm"),
      path.join(_homeDir, "AppData", "Local", "Programs", "Claude"),
      path.join(_homeDir, ".local", "bin"),
    ]
  : [
      path.join(_homeDir, ".local", "bin"),
      "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin",
    ]
).join(path.delimiter);
const SPAWN_ENV = Object.assign({}, process.env, {
  PATH: (process.env.PATH || "") + path.delimiter + EXTRA_PATH,
});
const CLAUDE_BIN = (() => {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const accessFlag = _isWindows ? fs.constants.F_OK : fs.constants.X_OK;
  const dirs = ((process.env.PATH || "") + path.delimiter + EXTRA_PATH)
    .split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of _claudeNames) {
      const p = path.join(dir, name);
      try { fs.accessSync(p, accessFlag); return p; } catch (e) {}
    }
  }
  return _claudeFallback;                                    // last resort: rely on PATH at spawn
})();
// True when we found a real `claude` binary (absolute path). When false AND no API
// key is set, image analysis can't run — we say so loudly at startup.
const CLAUDE_FOUND = CLAUDE_BIN !== _claudeFallback;
// True when the resolved binary is a Windows batch script (.cmd/.bat).
// Node/libuv cannot exec batch scripts directly — they need cmd.exe as host.
const _useShell = _isWindows && /\.(cmd|bat)$/i.test(CLAUDE_BIN);

if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// First run: if there's no library yet, seed it from the bundled demo set in
// ./samples (a handful of reference photos) so a fresh clone isn't empty.
// Your own library.json + library/ are gitignored, so this never overwrites them.
if (!fs.existsSync(LIB_JSON)) {
  const sampleJson = path.join(ROOT, "samples", "library.json");
  const sampleDir = path.join(ROOT, "samples", "library");
  try {
    if (fs.existsSync(sampleJson)) {
      for (const f of fs.readdirSync(sampleDir)) {
        fs.copyFileSync(path.join(sampleDir, f), path.join(LIB_DIR, f));
      }
      fs.copyFileSync(sampleJson, LIB_JSON);
    } else {
      fs.writeFileSync(LIB_JSON, "[]");
    }
  } catch (e) {
    fs.writeFileSync(LIB_JSON, "[]");
  }
}

// In-memory store for built zines, served at a real /zine/<id> URL so printing is reliable.
const zineStore = {};
let zineSeq = 0;
const CHROME_BIN = (() => { const c = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; try { return fs.existsSync(c) ? c : ""; } catch (e) { return ""; } })();

const SYSTEM_PROMPT = `You are helping an industrial designer build a moodboard from travel photographs. Look at the image and return ONLY a JSON object, no markdown, in this exact shape:
{
  "name": "2-3 word evocative name",
  "description": "one short sentence about what's in the image, in a designer's voice",
  "category": "one of: object, material, space, type, texture, detail",
  "mood": "one of: bold, quiet, warm, sharp, textured, weird",
  "colors": ["#hex1", "#hex2", "#hex3", "#hex4"],
  "materials": ["material1", "material2"]
}
Be specific and evocative. Name the actual thing you see. Pull real, accurate hex colors sampled from the image. Keep the description to one sentence with a designer's eye for form, light, and material.
For "materials", use simple, common one-word names from this kind of set — wood, stone, concrete, glass, metal, brass, copper, steel, iron, ceramic, terracotta, plaster, textile, leather, paper. Give at most 2, and avoid over-specific or compound names (say "stone", not "weathered cobblestone"; "wood", not "stained beech").`;

/* ---------------- helpers ---------------- */
function readLib() {
  try { return JSON.parse(fs.readFileSync(LIB_JSON, "utf8")); }
  catch (e) { return []; }
}
function writeLib(arr) {
  fs.writeFileSync(LIB_JSON, JSON.stringify(arr, null, 2));
}
function body(req) {
  return new Promise((res, rej) => {
    let chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try { res(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (e) { rej(new Error("bad json")); }
    });
    req.on("error", rej);
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}
function dataURLToBuffer(dataURL) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataURL || "");
  if (!m) return null;
  return { mediaType: m[1], buf: Buffer.from(m[2], "base64"), b64: m[2] };
}
function stripFences(t) {
  return (t || "").replace(/```json/gi, "").replace(/```/g, "").trim();
}
function normalize(p) {
  const cats = ["object", "material", "space", "type", "texture", "detail"];
  const moods = ["bold", "quiet", "warm", "sharp", "textured", "weird"];
  let colors = Array.isArray(p.colors) ? p.colors.filter(c => typeof c === "string") : [];
  colors = colors.map(c => (c.startsWith("#") ? c : "#" + c)).slice(0, 4);
  while (colors.length < 4) colors.push("#E5E5E5");
  return {
    name: (p.name || "untitled").toString().trim(),
    description: (p.description || "").toString().trim(),
    category: cats.includes((p.category || "").toLowerCase()) ? p.category.toLowerCase() : "detail",
    mood: moods.includes((p.mood || "").toLowerCase()) ? p.mood.toLowerCase() : "quiet",
    colors,
    materials: Array.isArray(p.materials) ? p.materials.map(m => ("" + m).trim()).filter(Boolean).slice(0, 4) : []
  };
}

/* ---------------- spawn helper ---------------- */
// Wraps Node's spawn() so that .cmd/.bat files work on Windows.
// libuv cannot exec batch scripts directly; we route them through cmd.exe.
// Each argument is quoted with the cmd.exe convention (surround with "...",
// escape inner " as "") and the whole command string is passed verbatim to
// CreateProcess (windowsVerbatimArguments) so Node doesn't add a second
// escaping layer on top of ours.
function spawnCLI(args, opts) {
  if (!_useShell) return spawn(CLAUDE_BIN, args, opts);
  // cmd.exe treats \n as a command terminator even inside double-quoted strings,
  // so newlines must be removed before the argument reaches the shell.
  const escArg = a => '"' + a.replace(/\r?\n|\r/g, ' ').replace(/"/g, '""') + '"';
  const cmdStr = [CLAUDE_BIN, ...args].map(escArg).join(' ');
  // /s strips exactly the first and last " of the string after /c.
  // Wrapping cmdStr in an extra outer "..." gives /s those to consume,
  // leaving the per-argument quotes intact — the standard cross-spawn pattern.
  return spawn(process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', '"' + cmdStr + '"'],
    { ...opts, windowsVerbatimArguments: true });
}

/* ---------------- analysis ---------------- */
// Pull the first {...} JSON object out of arbitrary text.
function extractJSON(text) {
  const cleaned = stripFences(text);
  try { return JSON.parse(cleaned); } catch (e) {}
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return JSON.parse(cleaned.slice(start, end + 1));
  }
  throw new Error("no JSON in model response");
}

// Run the local `claude` CLI in headless mode. Uses the user's existing
// Claude Code login — no API key. Returns the model's text result.
// The prompt is written to stdin instead of passed as a -p argument so that
// newlines, quotes, and braces in the JSON example never touch the shell's
// command-line parser (critical on Windows where cmd.exe re-interprets them).
function runClaudeCLI(imageRelPath) {
  return new Promise((resolve, reject) => {
    const prompt =
      "Read the image file at " + imageRelPath + ".\n\n" +
      SYSTEM_PROMPT + "\n\nReturn ONLY the JSON object and nothing else.";
    const args = ["-p", "--output-format", "json", "--allowedTools", "Read"];
    if (MODEL) args.push("--model", MODEL);

    let child;
    try {
      child = spawnCLI(args, { cwd: ROOT, env: SPAWN_ENV, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) { return reject(e); }

    child.stdin.write(prompt, "utf8");
    child.stdin.end();

    let out = "", err = "";
    const killer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("claude cli timed out")); }, 180000);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => err += d);
    child.on("error", e => { clearTimeout(killer); reject(e); }); // ENOENT if CLI missing
    child.on("close", code => {
      clearTimeout(killer);
      if (code !== 0) return reject(new Error((err.trim() || "claude exited " + code).slice(0, 200)));
      try {
        const env = JSON.parse(out);                 // CLI wrapper json
        resolve(env.result != null ? String(env.result) : out);
      } catch (e) { resolve(out); }                  // fall back to raw stdout
    });
  });
}

// macOS `sips` runner — used for HEIC→JPEG conversion and downscaling.
function runSips(args) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn("sips", args); }
    catch (e) { return reject(e); }
    let err = "";
    child.stderr.on("data", d => err += d);
    child.on("error", e => reject(e)); // ENOENT if not macOS / sips missing
    child.on("close", code => code === 0 ? resolve() : reject(new Error("sips: " + (err.trim() || code))));
  });
}

/* ---------------- photo metadata: location + date ---------------- */
const GEO_CACHE = path.join(CACHE_DIR, "geo.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readGeoCache() { try { return JSON.parse(fs.readFileSync(GEO_CACHE, "utf8")); } catch (e) { return {}; } }
function writeGeoCache(o) { try { fs.writeFileSync(GEO_CACHE, JSON.stringify(o)); } catch (e) {} }

// Read GPS + capture date from an image's EXIF via macOS `mdls`.
// Read GPS + capture date straight from a JPEG's EXIF bytes (APP1/TIFF). Returns
// nulls if the file isn't a JPEG or has no EXIF. This is the reliable path: it
// doesn't depend on Spotlight having indexed the file, which it won't have for a
// photo we just wrote to disk a moment ago.
function exifFromJpeg(absPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return { lat: null, lon: null, date: "" }; }
  const none = { lat: null, lon: null, date: "" };
  try {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return none;           // not a JPEG
    let off = 2;
    while (off < buf.length - 1) {
      if (buf[off] !== 0xFF) break;
      const marker = buf[off + 1], size = buf.readUInt16BE(off + 2);
      if (marker === 0xE1 && buf.toString("ascii", off + 4, off + 10) === "Exif\0\0") {
        const tiff = off + 10;
        const le = buf.toString("ascii", tiff, tiff + 2) === "II";
        const u16 = o => le ? buf.readUInt16LE(o) : buf.readUInt16BE(o);
        const u32 = o => le ? buf.readUInt32LE(o) : buf.readUInt32BE(o);
        const ifd0 = tiff + u32(tiff + 4);
        let gpsOff = 0, exifOff = 0;
        const n0 = u16(ifd0);
        for (let i = 0; i < n0; i++) { const e = ifd0 + 2 + i * 12, tag = u16(e); if (tag === 0x8825) gpsOff = tiff + u32(e + 8); if (tag === 0x8769) exifOff = tiff + u32(e + 8); }
        const out = { lat: null, lon: null, date: "" };
        if (gpsOff) {
          const gn = u16(gpsOff); let latRef, lonRef, lat, lon;
          const rat = o => u32(o) / u32(o + 4);
          const dms = o => rat(o) + rat(o + 8) / 60 + rat(o + 16) / 3600;
          for (let i = 0; i < gn; i++) {
            const e = gpsOff + 2 + i * 12, tag = u16(e);
            if (tag === 1) latRef = String.fromCharCode(buf[e + 8]);
            if (tag === 2) lat = dms(tiff + u32(e + 8));
            if (tag === 3) lonRef = String.fromCharCode(buf[e + 8]);
            if (tag === 4) lon = dms(tiff + u32(e + 8));
          }
          if (Number.isFinite(lat) && Number.isFinite(lon)) { out.lat = latRef === "S" ? -lat : lat; out.lon = lonRef === "W" ? -lon : lon; }
        }
        if (exifOff) {
          const en = u16(exifOff);
          for (let i = 0; i < en; i++) { const e = exifOff + 2 + i * 12, tag = u16(e); if (tag === 0x9003) { const d = buf.toString("ascii", tiff + u32(e + 8), tiff + u32(e + 8) + 10); if (/^\d{4}:\d{2}:\d{2}$/.test(d)) out.date = d.replace(/:/g, "-"); } }
        }
        return out;
      }
      off += 2 + size;
    }
  } catch (e) { /* malformed EXIF — fall through */ }
  return none;
}

// Spotlight (mdls) fallback — only reached when EXIF-from-bytes finds nothing
// (e.g. PNG/WEBP, or HEIC whose GPS didn't survive conversion).
function mdlsMeta(absPath) {
  return new Promise(resolve => {
    let child;
    try { child = spawn("mdls", ["-name", "kMDItemLatitude", "-name", "kMDItemLongitude", "-name", "kMDItemContentCreationDate", absPath]); }
    catch (e) { return resolve({ lat: null, lon: null, date: "" }); }
    let out = "";
    child.stdout.on("data", d => out += d);
    child.on("error", () => resolve({ lat: null, lon: null, date: "" })); // not macOS / no mdls
    child.on("close", () => {
      const num = k => { const m = new RegExp(k + "\\s*=\\s*([-0-9.]+)").exec(out); return m ? parseFloat(m[1]) : null; };
      const lat = num("kMDItemLatitude"), lon = num("kMDItemLongitude");
      const dm = /kMDItemContentCreationDate\s*=\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(out);
      resolve({ lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, date: dm ? dm[1] : "" });
    });
  });
}

// Capture metadata for a stored image: EXIF bytes first, Spotlight as a fallback.
async function readPhotoMeta(absPath) {
  const exif = exifFromJpeg(absPath);
  if (exif.lat != null && exif.lon != null) return exif;          // got coords straight from the file
  const md = await mdlsMeta(absPath);
  return { lat: md.lat, lon: md.lon, date: exif.date || md.date };
}

// Coordinates -> city name (cached by ~1km). Returns "" on any failure/offline.
async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return "";
  const key = lat.toFixed(2) + "," + lon.toFixed(2);
  const cache = readGeoCache();
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  let city = "";
  try {
    if (typeof fetch === "function") {
      const url = "https://nominatim.openstreetmap.org/reverse?lat=" + lat + "&lon=" + lon +
        "&format=json&zoom=10&addressdetails=1&accept-language=en";
      const r = await fetch(url, { headers: { "User-Agent": "FieldNotes/1.0 (personal moodboard app)" } });
      if (r.ok) { const a = (await r.json()).address || {}; city = a.city || a.town || a.village || a.municipality || a.county || ""; }
    }
  } catch (e) { city = ""; }
  if (city) { cache[key] = city; writeGeoCache(cache); }   // cache only successes, so we can retry later if offline
  return city;
}

// Best-effort {trip, date} for a source image. Never throws.
async function detectTripAndDate(absPath) {
  try {
    const m = await readPhotoMeta(absPath);
    const trip = await reverseGeocode(m.lat, m.lon);
    return { trip, date: m.date };
  } catch (e) { return { trip: "", date: "" }; }
}

// API fallback (only if ANTHROPIC_API_KEY is set AND the CLI is unavailable).
async function runAPIFromFile(absJpegPath) {
  if (typeof fetch !== "function") throw new Error("node 18+ required for api fallback");
  const b64 = fs.readFileSync(absJpegPath).toString("base64");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL || "claude-sonnet-4-5",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } },
        { type: "text", text: "Analyze this reference. Return only the JSON object." }
      ] }]
    })
  });
  if (!r.ok) {
    let msg = ""; try { msg = (await r.json())?.error?.message || ""; } catch (e) {}
    throw new Error(msg || ("anthropic " + r.status));
  }
  const out = await r.json();
  return (out.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

// Analyze a JPEG already written to disk. relPath is relative to ROOT (for the CLI).
async function analyzeFile(absPath, relPath) {
  let text;
  try {
    text = await runClaudeCLI(relPath);                         // keyless, via Claude Code
  } catch (cliErr) {
    if (API_KEY) text = await runAPIFromFile(absPath);          // optional fallback
    else if (cliErr.code === "ENOENT")
      throw new Error("the `claude` CLI was not found — install Claude Code, or set ANTHROPIC_API_KEY");
    else throw cliErr;
  }
  return normalize(extractJSON(text));
}

/* ---------------- static ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2", ".css": "text/css; charset=utf-8" };
function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "content-type": MIME[ext] || "application/octet-stream" };
    if (ext === ".html") headers["cache-control"] = "no-cache";   // always serve the latest UI
    else if (/\.(jpe?g|png|webp|woff2)$/.test(ext)) headers["cache-control"] = "max-age=604800"; // cache images/fonts a week
    res.writeHead(200, headers);
    res.end(data);
  });
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  try {
    // GET /  -> app
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      return serveFile(res, path.join(ROOT, "index.html"));
    }

    // GET /library/<file> -> stored image (path-safe)
    if (req.method === "GET" && p.startsWith("/library/")) {
      const name = path.basename(decodeURIComponent(p.slice("/library/".length)));
      return serveFile(res, path.join(LIB_DIR, name));
    }

    // GET /fonts/<file> -> self-hosted webfonts (no Google Fonts dependency; works offline)
    if (req.method === "GET" && p.startsWith("/fonts/")) {
      const name = path.basename(decodeURIComponent(p.slice("/fonts/".length)));
      return serveFile(res, path.join(ROOT, "fonts", name));
    }

    // PWA install support: web-app manifest + icons (so "Install as app" uses the Field Notes icon)
    if (req.method === "GET" && p === "/manifest.webmanifest") {
      const m = JSON.stringify({
        name: "Field Notes", short_name: "Field Notes",
        start_url: "/", scope: "/", display: "standalone",
        background_color: "#FFFFFF", theme_color: "#FFFFFF",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" }
        ]
      });
      res.writeHead(200, { "content-type": "application/manifest+json", "cache-control": "no-cache" });
      return res.end(m);
    }
    if (req.method === "GET" && p.startsWith("/icons/")) {
      const name = path.basename(decodeURIComponent(p.slice("/icons/".length)));
      return serveFile(res, path.join(ROOT, "icons", name));
    }

    // GET /library-print/<file>?w=N -> downscaled copy (cached per width) for grid/modal/zine.
    // Avoids loading the multi-megapixel originals just to show a small thumbnail.
    if (req.method === "GET" && p.startsWith("/library-print/")) {
      const name = path.basename(decodeURIComponent(p.slice("/library-print/".length)));
      const src = path.join(LIB_DIR, name);
      if (!fs.existsSync(src)) { res.writeHead(404); return res.end("not found"); }
      let w = parseInt(url.searchParams.get("w") || "1200", 10);
      if (!(w >= 200 && w <= 3000)) w = 1200;
      const cached = path.join(CACHE_DIR, "print_" + name + "_" + w + ".jpg");
      if (!fs.existsSync(cached)) {
        try { await runSips(["-Z", String(w), "-s", "format", "jpeg", src, "--out", cached]); }
        catch (e) { return serveFile(res, src); }          // sips missing: fall back to original
      }
      return serveFile(res, cached);
    }

    // GET /api/library -> all items
    if (req.method === "GET" && p === "/api/library") {
      return json(res, 200, readLib());
    }

    // GET /zine/<id> -> a previously built zine, served as a real page (prints reliably in Safari)
    if (req.method === "GET" && p.startsWith("/zine/")) {
      const z = zineStore[p.slice("/zine/".length)];
      if (!z) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("this zine expired — rebuild it from the app"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(z.html);
    }

    // GET /api/open?p=/zine/<id> -> open a zine in its own chromeless Chrome app window
    if (req.method === "GET" && p === "/api/open") {
      const target = url.searchParams.get("p") || "";
      if (!target.startsWith("/zine/")) return json(res, 400, { error: "bad target" });
      if (!CHROME_BIN) return json(res, 200, { ok: false });
      try { spawn(CHROME_BIN, ["--app=http://localhost:" + PORT + target]); return json(res, 200, { ok: true }); }
      catch (e) { return json(res, 200, { ok: false }); }
    }

    // POST /api/zine -> { html, title } : stash a built zine, return its id (keeps the last 20)
    if (req.method === "POST" && p === "/api/zine") {
      const b = await body(req);
      if (!b || typeof b.html !== "string" || b.html.length > 5000000) return json(res, 400, { error: "bad zine" });
      const id = (zineSeq++).toString(36) + Math.random().toString(36).slice(2, 6);
      zineStore[id] = { html: b.html, title: typeof b.title === "string" ? b.title : "" };
      const ids = Object.keys(zineStore);
      while (ids.length > 20) delete zineStore[ids.shift()];
      return json(res, 200, { id });
    }

    // POST /api/backfill -> fill missing trip/date on existing items from their image EXIF.
    // Only fills blanks — never overwrites a trip you've set by hand.
    if (req.method === "POST" && p === "/api/backfill") {
      const lib = readLib();
      let updated = 0;
      for (const it of lib) {
        const needTrip = !(it.folder || "").trim();
        const needDate = it.date === undefined || it.date === null;
        if (!needTrip && !needDate) continue;
        const abs = path.join(LIB_DIR, it.file);
        if (!fs.existsSync(abs)) { if (it.date === undefined) it.date = ""; continue; }
        const m = await readPhotoMeta(abs);
        if (needDate) it.date = m.date || "";
        if (needTrip) {
          const city = await reverseGeocode(m.lat, m.lon);
          if (city) it.folder = city;
          else if (it.folder === undefined) it.folder = "";
          if (m.lat != null) await sleep(1100);          // be polite to the geocoder (≤1 req/sec)
        }
        updated++;
      }
      writeLib(lib);
      return json(res, 200, { ok: true, updated, count: lib.length });
    }

    // POST /api/add -> { id, dataURL, filename } : convert, downscale, analyze, persist
    if (req.method === "POST" && p === "/api/add") {
      const it = await body(req);
      const parts = dataURLToBuffer(it.dataURL);
      if (!parts) return json(res, 400, { error: "bad image" });
      const id = (it.id && /^[\w-]+$/.test(it.id)) ? it.id : ("fn_" + Date.now());

      // Skip re-imports: if we already store a byte-identical photo, return it.
      // (Double-fires from the picker send fresh ids, so id-dedup alone misses them.)
      const sig = bufHash(parts.buf);
      {
        const lib0 = readLib();
        const dupe = lib0.find(x => x.id !== id && x.hash === sig);
        if (dupe) return json(res, 200, Object.assign({ duplicate: true }, dupe));
      }
      // already analysing this exact photo (concurrent double-import) — drop this one
      if (inFlight.has(sig)) return json(res, 200, { duplicate: true });
      inFlight.add(sig);
      res.on("close", () => inFlight.delete(sig));   // release no matter how we exit

      const fname = (it.filename || "").toLowerCase();
      const isHeic = /image\/hei[cf]/.test(parts.mediaType) || /\.(heic|heif)$/.test(fname);
      const isPng = parts.mediaType === "image/png" || /\.png$/.test(fname);
      const isWebp = parts.mediaType === "image/webp" || /\.webp$/.test(fname);

      // 1) write the uploaded bytes to a temp source file
      const srcExt = isHeic ? ".heic" : isPng ? ".png" : isWebp ? ".webp" : ".jpg";
      const srcAbs = path.join(CACHE_DIR, "src_" + id + srcExt);
      fs.writeFileSync(srcAbs, parts.buf);

      // 2) produce the full-res DISPLAY original (what shows on the page)
      let displayFile;
      try {
        if (isHeic) {
          displayFile = id + ".jpg";
          await runSips(["-s", "format", "jpeg", srcAbs, "--out", path.join(LIB_DIR, displayFile)]);
        } else {
          displayFile = id + srcExt;                 // keep the true original bytes
          fs.copyFileSync(srcAbs, path.join(LIB_DIR, displayFile));
        }
      } catch (e) {
        console.error("[upload] display-file step failed:", e);
        try { fs.unlinkSync(srcAbs); } catch (_) {}
        return json(res, 500, { error: isHeic ? "heic conversion failed — is this macOS? (needs sips)" : "could not store image" });
      }

      // 3) produce the downscaled analysis copy (<=1024px JPEG), sent to Claude only
      const anAbs = path.join(CACHE_DIR, "an_" + id + ".jpg");
      const anRel = path.join(".cache", "an_" + id + ".jpg");
      let analyzeAbs = anAbs, analyzeRel = anRel;
      try {
        await runSips(["-s", "format", "jpeg", "-Z", "1024", srcAbs, "--out", anAbs]);
      } catch (e) {
        // sips unavailable: fall back to analyzing the stored display file at full size
        analyzeAbs = path.join(LIB_DIR, displayFile);
        analyzeRel = path.join("library", displayFile);
      }

      // 4) analyze
      let meta;
      try {
        meta = await analyzeFile(analyzeAbs, analyzeRel);
      } catch (err) {
        console.error("[upload] analyzeFile failed:", err);
        try { fs.unlinkSync(srcAbs); } catch (_) {}
        try { fs.unlinkSync(anAbs); } catch (_) {}
        try { fs.unlinkSync(path.join(LIB_DIR, displayFile)); } catch (_) {}
        return json(res, 500, { error: (err && err.message) ? err.message : "analysis failed" });
      }

      // 5) auto-detect trip (location) + date from the stored image's EXIF.
      // Use the display file: for HEIC that's the converted JPEG (EXIF preserved),
      // for everything else it's the original bytes.
      const auto = await detectTripAndDate(path.join(LIB_DIR, displayFile));

      // 6) persist (replace any existing record with this id, so retries don't duplicate)
      let lib = readLib();
      const prev = lib.find(x => x.id === id);            // preserve manual edits across re-adds/retries
      const folder = (prev && prev.folder) ? prev.folder : (auto.trip || "");
      const date = (prev && prev.date) ? prev.date : (auto.date || "");
      const record = { id, file: displayFile, folder, date, hash: sig, ...meta, created: new Date().toISOString() };
      lib = lib.filter(x => x.id !== id);
      lib.unshift(record);
      writeLib(lib);

      // 6) clean up scratch files
      try { fs.unlinkSync(srcAbs); } catch (_) {}
      try { fs.unlinkSync(anAbs); } catch (_) {}

      return json(res, 200, record);
    }

    // PUT /api/item -> edit name/description/folder
    if (req.method === "PUT" && p === "/api/item") {
      const { id, name, description, folder } = await body(req);
      const lib = readLib();
      const it = lib.find(x => x.id === id);
      if (!it) return json(res, 404, { error: "not found" });
      if (typeof name === "string") it.name = name.trim() || it.name;
      if (typeof description === "string") it.description = description.trim();
      if (typeof folder === "string") it.folder = folder.trim();
      writeLib(lib);
      return json(res, 200, it);
    }

    // DELETE /api/item?id=... -> remove record + image
    if (req.method === "DELETE" && p === "/api/item") {
      const id = url.searchParams.get("id");
      let lib = readLib();
      const it = lib.find(x => x.id === id);
      if (it) {
        try { fs.unlinkSync(path.join(LIB_DIR, it.file)); } catch (e) {}
        lib = lib.filter(x => x.id !== id);
        writeLib(lib);
      }
      return json(res, 200, { ok: true });
    }

    res.writeHead(404); res.end("not found");
  } catch (err) {
    json(res, 500, { error: (err && err.message) ? err.message : "server error" });
  }
});

// Bind to loopback only: the app's whole promise is that nothing leaves this
// machine, so don't listen on the network at all.
server.listen(PORT, "127.0.0.1", () => {
  console.log("\n  Field Notes  →  http://localhost:" + PORT);
  console.log("  library: " + LIB_JSON);
  if (CLAUDE_FOUND) {
    console.log("  analysis: via `" + CLAUDE_BIN + "` CLI — no API key needed");
  } else if (API_KEY) {
    console.log("  analysis: ANTHROPIC_API_KEY set (using the Anthropic API)");
  } else {
    console.log("");
    console.log("  ⚠  image analysis isn't set up yet. The app will open and you can");
    console.log("     browse, but dropped photos can't be named/tagged until you do ONE of:");
    console.log("");
    console.log("       • install Claude Code and log in   → https://claude.com/claude-code");
    console.log("       • or add an API key to a .env file → ANTHROPIC_API_KEY=sk-ant-...");
    console.log("         (get one at https://console.anthropic.com)");
  }
  console.log("");
});
