/* Binder Scan — installable Pokémon card collection app.
   Card data/images: Pokémon TCG API. Names in Japanese/Korean/Chinese: names.js.
   eBay, exchange rates and 130point: your own Cloudflare Worker (see the setup guide). */
"use strict";

const APP_VERSION = "3.1.0";
const TCG_API = "https://api.pokemontcg.io/v2";
const TCG_SELECT = "id,name,number,rarity,set,images,tcgplayer,supertype";
const C = window.BinderConditions;
const N = window.BinderNames;
const LANGS = C.LANGS;

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const CUR = { USD: "US$", CAD: "C$", EUR: "€", GBP: "£", JPY: "¥" };
function money(v, cur = "CAD") {
  if (v == null || !isFinite(v)) return "—";
  const sym = CUR[cur] || cur + " ";
  return sym + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2));
}
function setStatus(el, msg, err) { if (!el) return; el.hidden = !msg; el.textContent = msg || ""; el.classList.toggle("err", !!err); }
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2800); }
function ago(ts) {
  if (!ts) return "";
  const d = (Date.now() - ts) / 864e5;
  return d < 1 ? "today" : d < 2 ? "yesterday" : `${Math.floor(d)} days ago`;
}
function lev(a, b) {
  a = a.toLowerCase().replace(/[^a-z0-9]/g, ""); b = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}
const settings = {
  get(k, d = "") { try { return localStorage.getItem("bs." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("bs." + k, v); } catch {} },
};

/* ---------------- storage ---------------- */
const store = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("binderscan", 2);
      r.onupgradeneeded = (e) => {
        const db = r.result;
        if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
        if (!db.objectStoreNames.contains("binders")) db.createObjectStore("binders", { keyPath: "id" });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(name, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(name, mode); const s = t.objectStore(name);
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    all: (n) => tx(n, "readonly", (s) => s.getAll()),
    put: (n, c) => tx(n, "readwrite", (s) => { s.put(c); }),
    putMany: (n, cs) => tx(n, "readwrite", (s) => { cs.forEach((c) => s.put(c)); }),
    del: (n, id) => tx(n, "readwrite", (s) => { s.delete(id); }),
  };
})();

let cards = [], binders = [], rates = null;
const DEFAULT_BINDER = "default";
const binderOf = (id) => binders.find((b) => b.id === id) || binders[0];
const cardsIn = (id) => cards.filter((c) => (c.binderId || DEFAULT_BINDER) === id);
let currentBinder = DEFAULT_BINDER;

async function saveCard(c) { const i = cards.findIndex((x) => x.id === c.id); if (i >= 0) cards[i] = c; else cards.unshift(c); await store.put("cards", c); renderBinder(); }
async function deleteCard(id) { cards = cards.filter((c) => c.id !== id); await store.del("cards", id); renderBinder(); }
async function saveBinder(b) { const i = binders.findIndex((x) => x.id === b.id); if (i >= 0) binders[i] = b; else binders.push(b); await store.put("binders", b); renderBinder(); }

/* ---------------- Pokémon TCG API ---------------- */
async function tcgSearch(q, { pageSize = 30, orderBy = "-set.releaseDate" } = {}) {
  const url = `${TCG_API}/cards?q=${encodeURIComponent(q)}&pageSize=${pageSize}&orderBy=${encodeURIComponent(orderBy)}&select=${TCG_SELECT}`;
  const key = settings.get("tcgKey").trim();
  const r = await fetch(url, { headers: key ? { "X-Api-Key": key } : {} });
  if (r.status === 429) throw new Error("The card database is busy. Wait a minute, or add a free API key in Settings.");
  if (!r.ok) throw new Error(`The card database didn't answer (error ${r.status}). Try again.`);
  return (await r.json()).data || [];
}
const VARIANT_LABEL = {
  normal: "Normal", holofoil: "Holo", reverseHolofoil: "Reverse Holo",
  "1stEditionHolofoil": "1st Edition Holo", "1stEditionNormal": "1st Edition",
  unlimitedHolofoil: "Unlimited Holo", unlimitedNormal: "Unlimited", "1stEdition": "1st Edition",
  shadowless: "Shadowless", other: "Other",
};
const variantLabel = (v) => VARIANT_LABEL[v] || v || "";
function variantsFor(api) {
  const keys = Object.keys(api?.tcgplayer?.prices || {});
  if (api?.set?.id === "base1") keys.push("shadowless");
  keys.push("other");
  return [...new Set(keys)];
}
function fromApi(api) {
  return {
    tcgId: api.id, name: api.name, number: api.number, rarity: api.rarity || "",
    setId: api.set?.id, setName: api.set?.name, series: api.set?.series, printedTotal: api.set?.printedTotal,
    releaseDate: api.set?.releaseDate,
    img: { small: api.images?.small, large: api.images?.large },
    tcg: api.tcgplayer ? { url: api.tcgplayer.url, updatedAt: api.tcgplayer.updatedAt, prices: api.tcgplayer.prices || {} } : null,
  };
}
const numLabel = (c) => (c.number ? (c.printedTotal && /^\d+$/.test(String(c.number)) ? `${c.number}/${c.printedTotal}` : c.number) : "");
function tcgMarketUsd(c) {
  const p = c.tcg?.prices || {};
  const v = p[c.variant] || p.holofoil || p.normal || Object.values(p)[0];
  return v ? v.market ?? v.mid ?? null : null;
}
/* rates are "1 CAD = X foreign", so dividing converts into CAD */
function cad(value, currency) {
  if (value == null || !isFinite(value)) return null;
  if (currency === "CAD") return value;
  const r = rates?.rates?.[currency];
  return r ? value / r : null;
}

function parseQuery(text) {
  const m = String(text).match(/([a-z]{0,4}\d{1,3})\s*\/\s*([a-z]{0,4}\d{1,3})/i);
  const name = String(text).replace(m ? m[0] : "", " ").replace(/[^\p{L}\s.'-]/gu, " ").replace(/\s+/g, " ").trim();
  return { name, num: m ? m[1] : null, total: m ? m[2] : null };
}
const cleanNum = (n) => (/^\d+$/.test(n) ? String(parseInt(n, 10)) : n.toUpperCase());
function nameClause(name) {
  const words = name.replace(/["\\]/g, "").split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words.length === 1 ? `name:${words[0]}*` : `name:"${words.join(" ")}"`;
}
async function findCards({ name, num, total }) {
  let results = [];
  if (num && total && /^\d+$/.test(total)) {
    results = await tcgSearch(`number:${cleanNum(num)} set.printedTotal:${parseInt(total, 10)}`);
    if (!results.length && name) results = await tcgSearch(`number:${cleanNum(num)} ${nameClause(name)}`);
  } else if (num && name) {
    results = await tcgSearch(`number:${cleanNum(num)} ${nameClause(name)}`);
  }
  if (!results.length && name) {
    results = await tcgSearch(nameClause(name), { pageSize: 48 });
    if (!results.length) {
      const longest = name.split(/\s+/).sort((a, b) => b.length - a.length)[0];
      if (longest && longest.length >= 4 && longest !== name) results = await tcgSearch(`name:*${longest}*`, { pageSize: 48 });
    }
    if (num) results.sort((a, b) => (b.number === cleanNum(num)) - (a.number === cleanNum(num)));
  }
  if (name && results.length > 1) {
    const score = (r) => Math.max(lev(r.name, name), ...name.split(/\s+/).map((w) => lev(r.name.split(/[\s-]/)[0], w)));
    results.sort((a, b) => score(b) - score(a));
  }
  return results;
}

/* ---------------- OCR ---------------- */
const TESS_LANG = { English: "eng", Japanese: "jpn", Korean: "kor", Chinese: "chi_tra" };
const workers = {};
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load")); document.head.appendChild(s); });
}
function getOcr(lang) {
  const code = TESS_LANG[lang] || "eng";
  if (!workers[code]) {
    workers[code] = (async () => {
      if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
      const w = await Tesseract.createWorker(code);
      await w.setParameters({ tessedit_pageseg_mode: "11" });
      return w;
    })().catch((e) => { delete workers[code]; throw e; });
  }
  return workers[code];
}
function loadImage(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
function band(img, x, y, w, h, outW = 1400) {
  const sx = img.naturalWidth * x, sy = img.naturalHeight * y, sw = img.naturalWidth * w, sh = img.naturalHeight * h;
  const scale = outW / sw, cv = document.createElement("canvas");
  cv.width = outW; cv.height = Math.max(1, Math.round(sh * scale));
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  const d = ctx.getImageData(0, 0, cv.width, cv.height), p = d.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < p.length; i += 4) { const g = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = g; if (g < lo) lo = g; if (g > hi) hi = g; }
  const k = 255 / Math.max(1, hi - lo);
  for (let i = 0; i < p.length; i += 4) { const g = (p[i] - lo) * k; p[i] = p[i + 1] = p[i + 2] = g; }
  ctx.putImageData(d, 0, 0);
  return cv;
}
function numberFrom(text) {
  const fixed = text.replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0").replace(/(?<=\d)[lI|](?=\d|\/)|(?<=\/)[lI|]/g, "1").replace(/\s*\/\s*/g, "/");
  const m = fixed.match(/\b([A-Z]{0,4}\d{1,3})\/([A-Z]{0,4}\d{1,3})\b/);
  return m ? { num: m[1], total: m[2] } : null;
}
const NAME_STOP = new Set(["basic", "stage", "evolves", "from", "pokemon", "pokémon", "put", "this", "card", "on", "the", "of", "hp", "lv", "level", "trainer", "energy", "item", "supporter", "tool", "ability", "rule", "box", "ex", "gx", "v", "vmax", "vstar", "tag", "team"]);
function nameFrom(text) {
  const words = text.split(/[^A-Za-zÀ-ÿ'.-]+/).map((w) => w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")).filter((w) => w.length >= 3 && !NAME_STOP.has(w.toLowerCase()) && /[a-z]/i.test(w));
  words.sort((a, b) => b.length - a.length);
  return words[0] || "";
}

/* Read one card. English first; if that finds nothing and the photo looks non-Latin,
   try the Asian languages. */
async function readCard(file, forceLang, onStep) {
  const img = await loadImage(file);
  const out = { language: forceLang || "English", name: "", num: null, total: null, foreign: "" };
  const topBand = band(img, 0.04, 0.02, 0.72, 0.12);
  const botBand = band(img, 0, 0.86, 1, 0.13);

  async function pass(lang) {
    onStep(`Reading the card${lang === "English" ? "" : " in " + lang}…`);
    const w = await getOcr(lang);
    const top = await w.recognize(topBand);
    const bottom = await w.recognize(botBand);
    return { top: top.data.text || "", bottom: bottom.data.text || "" };
  }

  let r = await pass(out.language);
  let nb = numberFrom(r.bottom) || numberFrom(r.top);
  if (!nb) {
    onStep("Looking a little harder…");
    const w = await getOcr(out.language);
    const full = await w.recognize(band(img, 0, 0, 1, 1, 1600));
    nb = numberFrom(full.data.text);
    r.top += " " + (full.data.text || "");
  }
  if (nb) { out.num = nb.num; out.total = nb.total; }

  if (!forceLang) {
    out.name = nameFrom(r.top);
    // English OCR over kana/hangul/hanzi returns junk, so a missing name is the clue to try again.
    if (!out.name || out.name.length < 3) {
      for (const lang of ["Japanese", "Korean", "Chinese"]) {
        onStep(`No English name found. Trying ${lang}…`);
        let rr;
        try { rr = await pass(lang); } catch { continue; }
        const script = C.detectScript(rr.top);
        if (!script) continue;
        const translated = await translate(rr.top, script, onStep);
        if (translated) { out.language = translated.lang; out.name = translated.en; out.foreign = rr.top.trim().split(/\s+/)[0] || ""; break; }
        if (script === lang) { out.language = lang; out.foreign = rr.top.trim().split(/\s+/)[0] || ""; }
      }
    }
  } else {
    const script = C.detectScript(r.top);
    const translated = await translate(r.top, script || forceLang, onStep);
    if (translated) { out.name = translated.en; out.language = translated.lang; }
    out.foreign = r.top.trim().split(/\s+/)[0] || "";
    if (!out.name) out.name = nameFrom(r.top);
  }
  URL.revokeObjectURL(img.src);
  return out;
}
async function translate(text, script, onStep) {
  try {
    if (!N.cached) onStep && onStep("Loading the Japanese, Korean and Chinese name list…");
    const loaded = await N.load();
    const hit = N.lookup(text, loaded);
    if (hit) return { en: hit.en, lang: script === "Chinese" || script === "Korean" || script === "Japanese" ? script : hit.lang };
  } catch (e) { nameLoadError = e.message; }
  return null;
}
let nameLoadError = "";

function makeThumb(file) {
  return loadImage(file).then((img) => {
    const w = 240, h = Math.round((w * 88) / 63), cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const x = cv.getContext("2d"), r = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * r, dh = img.naturalHeight * r; x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    URL.revokeObjectURL(img.src); return cv.toDataURL("image/jpeg", 0.72);
  }).catch(() => null);
}
function resizeTo(file, w, h, quality = 0.75) {
  return loadImage(file).then((img) => {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const x = cv.getContext("2d"), r = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * r, dh = img.naturalHeight * r; x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    URL.revokeObjectURL(img.src); return cv.toDataURL("image/jpeg", quality);
  }).catch(() => null);
}

/* ---------------- Scan ---------------- */
let scan = { file: null, thumb: null, read: null };
async function onPhoto(file, forceLang) {
  if (!file) return;
  scan = { file, thumb: null, read: null };
  const p = $("preview"); p.src = URL.createObjectURL(file); p.hidden = false; $("frameEmpty").hidden = true;
  $("frame").classList.add("has-photo", "scanning");
  $("resultsWrap").hidden = true; $("langRetry").hidden = true;
  scan.thumb = await makeThumb(file);
  try {
    const read = await readCard(file, forceLang, (m) => setStatus($("scanStatus"), m));
    scan.read = read;
    const said = [read.name || read.foreign, read.num && read.total ? `${read.num}/${read.total}` : read.num].filter(Boolean).join(" ");
    $("q").value = read.name ? [read.name, read.num && read.total ? `${read.num}/${read.total}` : read.num].filter(Boolean).join(" ") : "";
    $("langRetry").hidden = false;
    if (!read.name && !read.num) {
      setStatus($("scanStatus"), nameLoadError ? `Couldn't read the card, and the name list didn't load (${nameLoadError}). Type the English name and number above.`
        : "Couldn't read the name or number. Type it above, for example “charizard 4/102”.", true);
      return;
    }
    if (!read.name) {
      setStatus($("scanStatus"), `Read the number ${read.num}${read.total ? "/" + read.total : ""} but not the name. Add the English name above and search.`, true);
      return;
    }
    setStatus($("scanStatus"), `Read “${said}”${read.language !== "English" ? ` · ${read.language} card` : ""}. Searching…`);
    await runSearch(parseQuery($("q").value), said, read.language);
  } catch (e) {
    setStatus($("scanStatus"), e.message === "load" ? "The text reader couldn't load. Check your connection, or search by name instead." : e.message || "Reading failed. Search by name instead.", true);
    $("langRetry").hidden = false;
  } finally { $("frame").classList.remove("scanning"); }
}
async function runSearch(parsed, label, language) {
  try {
    const res = await findCards(parsed);
    renderPicks(res, (api) => openAddSheet(api, language || $("scanLang").value));
    setStatus($("scanStatus"), res.length
      ? `${res.length} possible match${res.length === 1 ? "" : "es"} for “${label}”. Tap yours.${language && language !== "English" ? ` It'll be saved as a ${language} card; the picture is the English print.` : ""}`
      : `No cards found for “${label}”. Check the spelling or try just the name.`, !res.length);
  } catch (e) { setStatus($("scanStatus"), e.message, true); }
}
function pickHTML(r) {
  return `<li><button class="pocket" data-id="${esc(r.id)}">
    <span class="art">${r.images?.small ? `<img src="${esc(r.images.small)}" alt="${esc(r.name)}" loading="lazy">` : `<span class="ph"></span>`}</span>
    <span class="nm">${esc(r.name)}</span>
    <span class="meta">${esc(r.set?.name || "")} · ${esc(r.number)}${r.set?.printedTotal && /^\d+$/.test(r.number) ? "/" + r.set.printedTotal : ""}</span>
  </button></li>`;
}
function renderPicks(results, onPick, listEl = $("results"), wrapEl = $("resultsWrap")) {
  wrapEl.hidden = !results.length;
  if ($("resultsNote") && listEl === $("results")) $("resultsNote").textContent = results.length ? "Newest sets first" : "";
  listEl.innerHTML = results.map(pickHTML).join("");
  listEl.onclick = (e) => { const b = e.target.closest(".pocket"); if (b) onPick(results.find((r) => r.id === b.dataset.id)); };
}
$("camInput").addEventListener("change", (e) => { const lang = $("scanLang").value; onPhoto(e.target.files[0], lang === "auto" ? null : lang); e.target.value = ""; });
$("galInput").addEventListener("change", (e) => { const lang = $("scanLang").value; onPhoto(e.target.files[0], lang === "auto" ? null : lang); e.target.value = ""; });
$("langRetry").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-lang]"); if (!b || !scan.file) return;
  $("scanLang").value = b.dataset.lang;
  onPhoto(scan.file, b.dataset.lang);
});
$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault(); const v = $("q").value.trim(); if (!v) return;
  const lang = $("scanLang").value;
  setStatus($("scanStatus"), "Searching…");
  runSearch(parseQuery(v), v, lang === "auto" ? scan.read?.language || "English" : lang);
});

/* ---------------- Condition + language editor ---------------- */
const RAW = ["NM", "LP", "MP", "HP", "DMG"];
const GRADERS = ["CGC", "PSA", "BGS", "TAG", "SGC", "ACE"];
const GRADES = ["Pristine 10", "Black Label 10", "10", "9.5", "9", "8.5", "8", "7.5", "7", "6", "5", "4", "3", "2", "1"];
function condEditorHTML(c) {
  const t = c.condType || "raw";
  return `<div class="f"><span class="label">Condition</span>
    <div class="seg" id="ceType"><button type="button" data-v="raw" aria-pressed="${t === "raw"}">Raw</button><button type="button" data-v="graded" aria-pressed="${t === "graded"}">Graded</button></div></div>
    <div class="seg" id="ceRaw" ${t === "raw" ? "" : "hidden"}>${RAW.map((k) => `<button type="button" data-v="${k}" aria-pressed="${(c.condition || "NM") === k}">${k}</button>`).join("")}</div>
    <div class="fields" id="ceGraded" ${t === "graded" ? "" : "hidden"}>
      <div class="f"><label for="ceGrader">Grader</label><select id="ceGrader">${GRADERS.map((g) => `<option ${c.grader === g ? "selected" : ""}>${g}</option>`).join("")}</select></div>
      <div class="f"><label for="ceGrade">Grade</label><select id="ceGrade" class="mono">${GRADES.map((g) => `<option ${(c.grade || "9") === g ? "selected" : ""}>${g}</option>`).join("")}</select></div>
    </div>`;
}
function wireCondEditor(state) {
  const seg = (el, cb) => el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; el.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); cb(b.dataset.v); });
  state.condType = state.condType || "raw"; state.condition = state.condition || "NM";
  seg($("ceType"), (v) => { state.condType = v; $("ceRaw").hidden = v !== "raw"; $("ceGraded").hidden = v !== "graded"; });
  seg($("ceRaw"), (v) => (state.condition = v));
  return () => {
    const out = { condType: state.condType };
    if (state.condType === "raw") Object.assign(out, { condition: state.condition, grader: null, grade: null });
    else Object.assign(out, { condition: null, grader: $("ceGrader").value, grade: $("ceGrade").value });
    return out;
  };
}
const condLabel = (c) => (c.condType === "graded" ? `${c.grader} ${c.grade}` : c.condition || "?");
const condClass = (c) => (c.condType === "graded" ? "g-slab" : "g-" + (c.condition || ""));
const displayName = (c) => (c.language && c.language !== "English" ? `${c.name} (${c.language})` : c.name);
const langOptions = (sel) => LANGS.map((l) => `<option ${l === sel ? "selected" : ""}>${l}</option>`).join("");
const binderOptions = (sel) => binders.map((b) => `<option value="${esc(b.id)}" ${b.id === sel ? "selected" : ""}>${esc(b.name)}</option>`).join("");

/* ---------------- Sheet ---------------- */
function openSheet(html) { $("sheetBody").innerHTML = html; $("sheet").hidden = false; $("sheet").querySelector(".sheet-panel").scrollTop = 0; }
function closeSheet() { $("sheet").hidden = true; $("sheetBody").innerHTML = ""; }
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

function openAddSheet(api, language) {
  const base = fromApi(api);
  const variants = variantsFor(api);
  const state = { condType: "raw", condition: "NM" };
  const tm = tcgMarketUsd({ ...base, variant: variants[0] });
  openSheet(`
    <div class="hero"><img src="${esc(base.img.large || base.img.small)}" alt="${esc(base.name)}">
      <div><span class="label">${esc(base.setName)} · ${esc(numLabel(base))}</span><h2 id="sheetTitle">${esc(base.name)}</h2>
      <span class="small muted">${esc([base.rarity, base.series, (base.releaseDate || "").slice(0, 4)].filter(Boolean).join(" · "))}</span>
      ${tm ? `<span class="small">TCGplayer market <b class="mono">${money(cad(tm, "USD") ?? tm, cad(tm, "USD") ? "CAD" : "USD")}</b></span>` : ""}</div></div>
    <div class="fields">
      <div class="f"><label for="aBinder">Binder</label><select id="aBinder">${binderOptions(currentBinder)}</select></div>
      <div class="f"><label for="aLang">Language</label><select id="aLang">${langOptions(language || "English")}</select></div>
      <div class="f"><label for="aVariant">Version</label><select id="aVariant">${variants.map((v) => `<option value="${v}">${esc(variantLabel(v))}</option>`).join("")}</select></div>
      <div class="f"><label for="aQty">Quantity</label><input id="aQty" type="number" min="1" value="1" class="mono" inputmode="numeric"></div>
    </div>
    ${condEditorHTML(state)}
    <div class="f"><label for="aNotes">Notes</label><input id="aNotes" placeholder="Centering, whitening, surface…"></div>
    ${scan.thumb ? `<label class="small check"><input type="checkbox" id="aKeepPhoto" checked> Keep my photo with this card</label>` : ""}
    <div class="row"><button class="primary" id="aSave">Add to binder</button><button id="aCancel">Cancel</button></div>`);
  const getCond = wireCondEditor(state);
  $("aCancel").onclick = closeSheet;
  $("aSave").onclick = async () => {
    const card = { id: uid(), ...base, binderId: $("aBinder").value, language: $("aLang").value, variant: $("aVariant").value,
      qty: Math.max(1, parseInt($("aQty").value, 10) || 1), ...getCond(), notes: $("aNotes").value.trim(),
      photo: $("aKeepPhoto")?.checked ? scan.thumb : null, foreignName: scan.read?.foreign || null, added: Date.now(), ebay: null, p130: null };
    await saveCard(card); closeSheet();
    toast(`Added ${displayName(card)} (${condLabel(card)})`);
    resetScan();
  };
}
function resetScan() {
  scan = { file: null, thumb: null, read: null }; $("preview").hidden = true; $("frameEmpty").hidden = false; $("frame").classList.remove("has-photo");
  $("resultsWrap").hidden = true; $("langRetry").hidden = true; $("q").value = ""; setStatus($("scanStatus"), "");
}

/* ---------------- Value ---------------- */
function cardValue(c) {
  const j = c.jtcg?.price, p = c.p130?.stats, s = c.ebay?.sold, a = c.ebay?.active;
  if (j != null) return { v: j, src: "JustTCG" };
  if (p?.median) return { v: p.median, src: "130point sold" };
  if (s?.median) return { v: s.median, src: "eBay sold" };
  if (a?.median) return { v: a.median, src: "eBay asking" };
  if (c.condType !== "graded" && c.language === "English") {
    const t = tcgMarketUsd(c);
    const inCad = cad(t, "USD");
    if (inCad) return { v: inCad, src: "TCGplayer" };
  }
  return null;
}

/* ---------------- Binder view ---------------- */
function renderBinder() {
  if (!binders.length) return;
  if (!binders.some((b) => b.id === currentBinder)) currentBinder = binders[0].id;
  const mine = cardsIn(currentBinder);
  const totalAll = cards.reduce((a, c) => a + (c.qty || 1), 0);
  $("hdrCount").textContent = `${totalAll} card${totalAll === 1 ? "" : "s"}`;

  const sum = (list) => list.reduce((a, c) => { const v = cardValue(c); return a + (v ? v.v * (c.qty || 1) : 0); }, 0);
  const unpriced = mine.filter((c) => !cardValue(c)).length;
  $("sValue").textContent = money(sum(mine), "CAD");
  $("sValueNote").textContent = [`${binders.length > 1 ? "this binder · " : ""}all binders ${money(sum(cards), "CAD")}`, unpriced ? `${unpriced} unpriced` : ""].filter(Boolean).join(" · ");
  $("sCards").textContent = mine.reduce((a, c) => a + (c.qty || 1), 0);
  $("sUnique").textContent = `${mine.length} unique`;
  $("sGraded").textContent = mine.filter((c) => c.condType === "graded").reduce((a, c) => a + (c.qty || 1), 0);

  // binder strip
  $("binderStrip").innerHTML = binders.map((b) => {
    const n = cardsIn(b.id).reduce((a, c) => a + (c.qty || 1), 0);
    return `<button class="tab-binder" data-binder="${esc(b.id)}" aria-pressed="${b.id === currentBinder}">
      <span class="cover">${b.cover ? `<img src="${esc(b.cover)}" alt="">` : `<span class="cover-ph"></span>`}</span>
      <span class="bn">${esc(b.name)}</span><span class="bc">${n}</span></button>`;
  }).join("") + `<button class="tab-binder add" id="btnNewBinder"><span class="cover"><span class="cover-ph plus">+</span></span><span class="bn">New binder</span></button>`;

  const q = $("filter").value.trim().toLowerCase(), sort = $("sort").value;
  let list = mine.filter((c) => !q || [c.name, c.setName, c.number, numLabel(c), c.language].join(" ").toLowerCase().includes(q));
  const cmp = {
    new: (a, b) => (b.added || 0) - (a.added || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    set: (a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "") || (parseInt(a.number) || 0) - (parseInt(b.number) || 0),
    value: (a, b) => (cardValue(b)?.v || 0) - (cardValue(a)?.v || 0),
  }[sort];
  list.sort(cmp);
  $("empty").hidden = mine.length > 0;
  $("binder").innerHTML = list.map((c) => {
    const v = cardValue(c);
    const art = c.img?.small
      ? `<img src="${esc(c.img.small)}" alt="${esc(c.name)}" loading="lazy" data-fallback="1">`
      : c.photo ? `<img src="${esc(c.photo)}" alt="${esc(c.name)}">` : `<span class="ph"></span><span class="ph-name">${esc(c.name)}</span>`;
    return `<li><button class="pocket" data-id="${esc(c.id)}">
      <span class="art">${art}<span class="chip ${condClass(c)}">${esc(condLabel(c))}</span>${c.qty > 1 ? `<span class="qty">×${c.qty}</span>` : ""}${c.language && c.language !== "English" ? `<span class="lang">${esc(c.language.slice(0, 2).toUpperCase())}</span>` : ""}</span>
      <span class="nm">${esc(displayName(c))}</span>
      <span class="meta">${esc(c.setName || "")} · ${esc(numLabel(c))}</span>
      <span class="price">${v ? money(v.v, "CAD") : "<span class='muted'>no price</span>"}</span>
    </button></li>`;
  }).join("");
  $("binder").querySelectorAll("img[data-fallback]").forEach((img) => {
    img.addEventListener("error", () => {
      const c = cards.find((x) => x.id === img.closest(".pocket").dataset.id);
      if (c?.photo && img.src !== c.photo) img.src = c.photo;
      else img.replaceWith(Object.assign(document.createElement("span"), { className: "ph" }));
    });
  });
}
$("filter").addEventListener("input", renderBinder);
$("sort").addEventListener("change", renderBinder);
$("binder").addEventListener("click", (e) => { const b = e.target.closest(".pocket"); if (b) openCardSheet(b.dataset.id); });
$("binderStrip").addEventListener("click", (e) => {
  if (e.target.closest("#btnNewBinder")) return openBinderSheet(null);
  const b = e.target.closest("[data-binder]");
  if (b) { currentBinder = b.dataset.binder; settings.set("binder", currentBinder); renderBinder(); }
});
$("btnEditBinder").addEventListener("click", () => openBinderSheet(currentBinder));

/* ---------------- Binder editor ---------------- */
function openBinderSheet(id) {
  const b = id ? binderOf(id) : { id: uid(), name: "", cover: null, created: Date.now() };
  const isNew = !id;
  const count = id ? cardsIn(id).length : 0;
  openSheet(`
    <h2 id="sheetTitle">${isNew ? "New binder" : "Edit binder"}</h2>
    <div class="binder-edit">
      <span class="cover big" id="bCoverBox">${b.cover ? `<img id="bCoverImg" src="${esc(b.cover)}" alt="">` : `<span class="cover-ph" id="bCoverPh"></span>`}</span>
      <div class="f">
        <label for="bName">Name</label><input id="bName" value="${esc(b.name)}" placeholder="Vintage WOTC" maxlength="40">
        <label class="btn small-btn" for="bCover">${b.cover ? "Change cover photo" : "Add cover photo"}</label>
        <input type="file" id="bCover" accept="image/*" class="visually-hidden">
        ${b.cover ? `<button id="bCoverClear" class="small-btn">Remove cover</button>` : ""}
      </div>
    </div>
    ${!isNew && binders.length > 1 ? `<div class="f"><label for="bMove">Move all ${count} cards to</label>
      <div class="search-row"><select id="bMove">${binders.filter((x) => x.id !== b.id).map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("")}</select><button id="bMoveGo">Move</button></div></div>` : ""}
    <div class="row"><button class="primary" id="bSave">${isNew ? "Create binder" : "Save"}</button><button id="bCancel">Cancel</button></div>
    ${!isNew && binders.length > 1 ? `<button class="danger" id="bDel">Delete binder</button>
      <div class="row" id="bConfirm" hidden><button class="danger" id="bYes">Delete, and move ${count} cards to ${esc(binders.find((x) => x.id !== b.id).name)}</button><button id="bNo">Keep it</button></div>` : ""}`);
  let cover = b.cover;
  $("bCover").addEventListener("change", async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    cover = await resizeTo(f, 300, 300, 0.78);
    $("bCoverBox").innerHTML = cover ? `<img src="${cover}" alt="">` : `<span class="cover-ph"></span>`;
  });
  if ($("bCoverClear")) $("bCoverClear").onclick = () => { cover = null; $("bCoverBox").innerHTML = `<span class="cover-ph"></span>`; };
  $("bCancel").onclick = closeSheet;
  $("bSave").onclick = async () => {
    const name = $("bName").value.trim() || (isNew ? "New binder" : b.name);
    await saveBinder({ ...b, name, cover });
    if (isNew) { currentBinder = b.id; settings.set("binder", b.id); }
    renderBinder(); closeSheet(); toast(isNew ? `Created ${name}` : "Saved");
  };
  if ($("bMoveGo")) $("bMoveGo").onclick = async () => {
    const to = $("bMove").value, moving = cardsIn(b.id);
    moving.forEach((c) => (c.binderId = to));
    await store.putMany("cards", moving); renderBinder(); closeSheet(); toast(`Moved ${moving.length} cards`);
  };
  if ($("bDel")) {
    $("bDel").onclick = () => ($("bConfirm").hidden = false);
    $("bNo").onclick = () => ($("bConfirm").hidden = true);
    $("bYes").onclick = async () => {
      const to = binders.find((x) => x.id !== b.id).id;
      const moving = cardsIn(b.id); moving.forEach((c) => (c.binderId = to));
      await store.putMany("cards", moving);
      binders = binders.filter((x) => x.id !== b.id); await store.del("binders", b.id);
      currentBinder = to; settings.set("binder", to); renderBinder(); closeSheet(); toast("Binder deleted");
    };
  }
}

/* ---------------- Card detail ---------------- */
function openCardSheet(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  const state = { condType: c.condType, condition: c.condition };
  const tmUsd = tcgMarketUsd(c), tm = cad(tmUsd, "USD");
  const img = c.img?.large || c.img?.small || c.photo || "";
  const variants = c.tcg ? [...new Set([...(Object.keys(c.tcg.prices || {})), c.setId === "base1" ? "shadowless" : null, "other", c.variant].filter(Boolean))] : [c.variant || "other"];
  openSheet(`
    <div class="hero">${img ? `<img id="dImg" src="${esc(img)}" alt="${esc(c.name)}">` : `<span></span>`}
      <div><span class="label">${esc(c.setName || "Unknown set")} · ${esc(numLabel(c))}</span><h2 id="sheetTitle">${esc(displayName(c))}</h2>
      <span class="small muted">${esc([c.rarity, variantLabel(c.variant), (c.releaseDate || "").slice(0, 4)].filter(Boolean).join(" · "))}</span>
      ${c.language !== "English" && c.img?.small ? `<span class="small muted">Picture is the English print${c.foreignName ? ` · scanned as ${esc(c.foreignName)}` : ""}.</span>` : ""}
      ${c.photo && c.img?.small ? `<div class="photo-toggle"><button id="dArt" aria-pressed="true">Card art</button><button id="dPhoto" aria-pressed="false">My photo</button></div>` : ""}
      ${!c.tcgId ? `<button id="dMatch" class="primary">Find official card</button>` : ""}</div></div>

    <div class="panel">
      <div class="section-head"><h3>Value</h3><span class="small muted" id="dValSrc"></span></div>
      <div class="big-num" id="dVal">—</div>
      <div class="kv">
        <span>JustTCG, ${esc(condLabel(c))}</span><span class="v" id="dJtcg">${jtcgLine(c)}</span>
        <span>130point sold, ${esc(condLabel(c))}</span><span class="v" id="dP130">${sumLine(c.p130?.stats, c.p130?.error)}</span>
        <span>eBay sold, ${esc(condLabel(c))}</span><span class="v">${sumLine(c.ebay?.sold)}</span>
        <span>eBay asking, ${esc(condLabel(c))}</span><span class="v">${sumLine(c.ebay?.active)}</span>
        <span>TCGplayer market${c.condType === "graded" ? " (raw)" : ""}</span><span class="v">${tm ? (c.tcg?.url ? `<a href="${esc(c.tcg.url)}" target="_blank" rel="noopener">${money(tm)}</a>` : money(tm)) : "—"}</span>
      </div>
      <div id="dJtcgOthers" hidden></div>
      <div class="row"><button class="primary" id="dCheck">${c.ebay || c.p130 || c.jtcg ? "Re-check prices" : "Check prices"}</button></div>
      <div class="status" id="dEbayStatus" hidden></div>
      <div id="dListings"></div>
    </div>

    <div class="fields">
      <div class="f"><label for="dBinder">Binder</label><select id="dBinder">${binderOptions(c.binderId || DEFAULT_BINDER)}</select></div>
      <div class="f"><label for="dLang">Language</label><select id="dLang">${langOptions(c.language || "English")}</select></div>
      <div class="f"><label for="dVariant">Version</label><select id="dVariant">${variants.map((v) => `<option value="${esc(v)}" ${v === c.variant ? "selected" : ""}>${esc(variantLabel(v))}</option>`).join("")}</select></div>
      <div class="f"><label for="dQty">Quantity</label><input id="dQty" type="number" min="1" class="mono" value="${c.qty || 1}" inputmode="numeric"></div>
    </div>
    ${condEditorHTML(c)}
    <div class="f"><label for="dNotes">Notes</label><input id="dNotes" value="${esc(c.notes || "")}"></div>
    <div class="row"><button class="primary" id="dSave">Save changes</button><button class="danger" id="dDel">Remove</button></div>
    <div class="row" id="dConfirm" hidden><button class="danger" id="dYes">Yes, remove this card</button><button id="dNo">Keep it</button></div>
    <button id="dClose">Close</button>`);
  const getCond = wireCondEditor(state);
  const val = cardValue(c);
  $("dVal").textContent = val ? money(val.v, "CAD") : "—";
  $("dValSrc").textContent = val ? `from ${val.src}` : "no price yet";
  if ($("dArt")) {
    $("dArt").onclick = () => { $("dImg").src = c.img.large || c.img.small; $("dArt").setAttribute("aria-pressed", true); $("dPhoto").setAttribute("aria-pressed", false); };
    $("dPhoto").onclick = () => { $("dImg").src = c.photo; $("dPhoto").setAttribute("aria-pressed", true); $("dArt").setAttribute("aria-pressed", false); };
  }
  if ($("dMatch")) $("dMatch").onclick = () => openMatchSheet(c.id);
  $("dCheck").onclick = () => checkPrices(c.id);
  $("dSave").onclick = async () => {
    const before = condLabel(c) + c.variant + c.language;
    Object.assign(c, getCond(), { binderId: $("dBinder").value, language: $("dLang").value, variant: $("dVariant").value,
      qty: Math.max(1, parseInt($("dQty").value, 10) || 1), notes: $("dNotes").value.trim() });
    if (condLabel(c) + c.variant + c.language !== before) { c.ebay = null; c.p130 = null; }
    if (c.binderId !== currentBinder) currentBinder = c.binderId;
    await saveCard(c); closeSheet(); toast("Saved");
  };
  $("dDel").onclick = () => ($("dConfirm").hidden = false);
  $("dNo").onclick = () => ($("dConfirm").hidden = true);
  $("dYes").onclick = async () => { await deleteCard(c.id); closeSheet(); toast("Removed"); };
  $("dClose").onclick = closeSheet;
  if (c.listings?.length) renderListings(c);
  renderJtcgOthers(c);
}
/* JustTCG also prices the other conditions and grades of the same card. */
function renderJtcgOthers(c) {
  const box = $("dJtcgOthers"); if (!box) return;
  const others = (c.jtcg?.others || []).filter((o) => o.price != null && o.label);
  if (!others.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = `<details><summary class="small">Other conditions and grades (${others.length})</summary>
    <div class="kv">${others.map((o) => `<span>${esc(o.label)}</span><span class="v">${money(o.price, "CAD")}</span>`).join("")}</div>
    ${c.jtcg.updated ? `<p class="small muted">JustTCG updated ${esc(String(c.jtcg.updated).slice(0, 10))}${c.jtcg.version === "v1" ? " · v1, graded prices need the v2 beta" : ""}.</p>` : ""}</details>`;
}
function jtcgLine(c) {
  const j = c.jtcg;
  if (!j) return "—";
  if (j.error) return `<span class='muted'>${esc(j.error)}</span>`;
  if (j.price == null) return `<span class='muted'>${esc(j.note || "no match")}</span>`;
  const ch = j.change24h;
  return `${money(j.price, "CAD")}${ch != null && Math.abs(ch) >= 0.5 ? ` <span class="small ${ch > 0 ? "up" : "down"}">${ch > 0 ? "+" : ""}${ch.toFixed(1)}%</span>` : ""}`;
}
function sumLine(s, error) {
  if (error) return `<span class='muted'>${esc(error)}</span>`;
  if (!s) return "—";
  if (s.error === "not_approved") return "<span class='muted'>needs eBay approval</span>";
  if (s.error) return `<span class='muted'>${esc(s.errorText || "unavailable")}</span>`;
  if (!s.median) return `<span class='muted'>none found</span>`;
  return `${money(s.median, "CAD")} <span class="muted small">(${s.n})</span>`;
}

async function openMatchSheet(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  openSheet(`<div class="section-head"><h2 id="sheetTitle">Find ${esc(c.name)}</h2></div>
    <form class="search-row" id="mForm"><input id="mQ" type="search" value="${esc([c.name, numLabel(c)].join(" "))}"><button type="submit">Search</button></form>
    <div class="status" id="mStatus">Searching…</div><ul class="pick-grid" id="mResults"></ul><div id="mWrap"></div><button id="mClose">Cancel</button>`);
  $("mClose").onclick = () => openCardSheet(id);
  const go = async () => {
    setStatus($("mStatus"), "Searching…");
    try {
      const res = await findCards(parseQuery($("mQ").value));
      renderPicks(res, async (api) => {
        const keep = { binderId: c.binderId, language: c.language, qty: c.qty, condType: c.condType, condition: c.condition, grader: c.grader, grade: c.grade, notes: c.notes, photo: c.photo };
        Object.assign(c, fromApi(api), keep); const vs = variantsFor(api); if (!vs.includes(c.variant)) c.variant = vs[0];
        c.ebay = null; c.p130 = null;
        await saveCard(c); openCardSheet(c.id); toast("Card art added");
      }, $("mResults"), $("mWrap"));
      setStatus($("mStatus"), res.length ? "Tap the right card." : "Nothing found. Edit the search and try again.", !res.length);
    } catch (e) { setStatus($("mStatus"), e.message, true); }
  };
  $("mForm").onsubmit = (e) => { e.preventDefault(); go(); };
  go();
}

/* ---------------- Prices ---------------- */
function workerBase() { return settings.get("worker").trim().replace(/\/+$/, ""); }
async function helper(path, params) {
  const base = workerBase();
  if (!base) throw Object.assign(new Error("Add your price helper address in Settings first."), { code: "no_worker" });
  const r = await fetch(`${base}${path}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `Price helper error ${r.status}`), { code: j.error || "http_" + r.status });
  return j;
}
function searchQuery(c) {
  const name = c.name.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim();
  const parts = [name, numLabel(c) || c.number];
  if (c.language && c.language !== "English") parts.push(c.language);
  if (c.variant && /1st/i.test(c.variant)) parts.push("1st edition");
  if (c.variant === "shadowless") parts.push("shadowless");
  if (c.variant === "reverseHolofoil") parts.push("reverse");
  if (c.condType === "graded") parts.push(c.grader, String(c.grade).replace(/^(Pristine|Black Label) /, ""));
  return parts.filter(Boolean).join(" ");
}
function priceOf(it) {
  if (it.priceCad != null) return { v: it.priceCad, orig: it.price || it.lastSoldPrice };
  const p = it.price || it.lastSoldPrice || (it.priceValue != null ? { value: it.priceValue, currency: it.currency } : null);
  if (!p) return { v: null, orig: null };
  return { v: cad(Number(p.value), p.currency), orig: p };
}
function summarize(items, card) {
  const parsed = items.map((it) => ({ it, r: C.parseListing(it, card) }));
  const prices = parsed.filter((p) => p.r.status === "match").map((p) => priceOf(p.it).v).filter((n) => n > 0);
  const st = C.robustStats(prices);
  return { parsed, stats: st ? { median: st.median, low: st.low, high: st.high, n: st.n, dropped: st.dropped, at: Date.now() } : { median: null, n: 0, at: Date.now() } };
}
async function describeUnknowns(parsed, card, max = 6) {
  const unknown = parsed.filter((p) => p.r.status === "unknown" && p.it.itemId).slice(0, max);
  await Promise.all(unknown.map(async (p) => {
    try {
      const d = await helper("/item", { id: p.it.itemId, market: p.it.market || "EBAY_US" });
      Object.assign(p.it, { description: d.description, descriptors: d.descriptors, conditionId: d.conditionId ?? p.it.conditionId });
      p.r = C.parseListing(p.it, card);
    } catch {}
  }));
}
function slim(p, kind, source) {
  const pr = priceOf(p.it);
  return { kind, source, status: p.r.status, cond: p.r.cond?.label || null, src: p.r.cond?.source || null, reason: p.r.reason || null,
    title: p.it.title, url: p.it.itemWebUrl || p.it.url, price: pr.v, orig: pr.orig, site: p.it.site || "eBay", date: p.it.lastSoldDate || p.it.date || null };
}

async function checkPrices(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  const st = $("dEbayStatus"); $("dCheck").disabled = true;
  setStatus(st, "Checking prices…");
  const q = searchQuery(c);
  const params = { q, cond: c.condType === "graded" ? "graded" : "raw", lang: c.language || "English" };
  try {
    if (!rates) rates = await helper("/rates", {}).catch(() => null);
    const jtcgParams = { q: c.name, number: c.number || "", set: c.setName || "", printing: c.variant || "",
      language: c.language && c.language !== "English" ? c.language : "" };
    if (c.condType === "graded") Object.assign(jtcgParams, { graded: "1", grading_company: c.grader || "", grade: c.grade || "" });
    else jtcgParams.condition = c.condition || "NM";

    const [act, soldEbay, p130, jt] = await Promise.allSettled([
      helper("/active", params), helper("/sold", params), helper("/p130", { q, cond: params.cond }), helper("/justtcg", jtcgParams),
    ]);
    if (act.status === "rejected" && act.reason.code === "no_worker") throw act.reason;

    const listings = [];
    c.ebay = { at: Date.now(), query: q };
    if (act.status === "fulfilled") {
      if (act.value.rates) rates = act.value.rates;
      const s = summarize(act.value.items || [], c);
      await describeUnknowns(s.parsed, c);
      const s2 = summarize(s.parsed.map((p) => p.it), c);
      c.ebay.active = s2.stats; c.ebay.sites = act.value.sites;
      listings.push(...s2.parsed.map((p) => slim(p, "active", "eBay")));
    } else c.ebay.active = { error: act.reason.code, errorText: act.reason.message };

    if (soldEbay.status === "fulfilled") {
      const s = summarize(soldEbay.value.items || [], c);
      c.ebay.sold = s.stats;
      listings.unshift(...s.parsed.map((p) => slim(p, "sold", "eBay")));
    } else c.ebay.sold = { error: soldEbay.reason.code, errorText: soldEbay.reason.code === "not_approved" ? "needs eBay approval" : soldEbay.reason.message };

    if (p130.status === "fulfilled") {
      const items = (p130.value.items || []).map((i) => ({ title: i.title, url: i.url, lastSoldDate: i.date, site: i.site || "eBay", price: { value: i.price, currency: i.currency } }));
      const s = summarize(items, c);
      c.p130 = { at: Date.now(), query: q, stats: s.stats };
      listings.unshift(...s.parsed.map((p) => slim(p, "sold", "130point")));
    } else c.p130 = { at: Date.now(), error: p130.reason.message, code: p130.reason.code };

    if (jt.status === "fulfilled") {
      const v = jt.value.chosen;
      c.jtcg = { at: Date.now(), version: jt.value.version, note: jt.value.note || null, quota: jt.value.quota,
        price: v ? cad(v.price, v.currency || "USD") : null, orig: v ? { value: v.price, currency: v.currency } : null,
        condition: v?.condition || null, printing: v?.printing || null, grading: v?.grading || null,
        change24h: v?.change24h ?? null, updated: v?.updated || null,
        others: (jt.value.variants || []).filter((x) => x !== v).slice(0, 12).map((x) => ({
          label: x.grading ? `${x.grading.company} ${x.grading.label || x.grading.grade}` : [x.condition, x.printing].filter(Boolean).join(" · "),
          price: cad(x.price, x.currency || "USD") })) };
    } else c.jtcg = { at: Date.now(), error: jt.reason.message, code: jt.reason.code };

    c.listings = listings.slice(0, 120);
    await saveCard(c);

    const counts = listings.reduce((a, l) => ((a[l.status] = (a[l.status] || 0) + 1), a), {});
    const bits = [`${listings.length} listings checked: ${counts.match || 0} match ${condLabel(c)}, ${counts.other || 0} other condition, ${counts.unknown || 0} condition not stated, ${counts.excluded || 0} skipped.`];
    if (c.jtcg?.error) bits.push(`JustTCG: ${c.jtcg.error}`);
    else if (c.jtcg?.quota?.remaining != null) bits.push(`JustTCG calls left today: ${c.jtcg.quota.remaining}.`);
    if (c.p130?.error) bits.push(`130point: ${c.p130.error}`);
    if (c.ebay.sold?.error === "not_approved") bits.push("eBay sold prices need Marketplace Insights approval.");
    const down = Object.values(c.ebay.sites || {}).filter((s) => !s.ok).map((s) => s.site);
    if (down.length) bits.push(`No answer from ${down.join(" and ")}.`);
    openCardSheet(c.id); setStatus($("dEbayStatus"), bits.join(" "));
  } catch (e) {
    setStatus(st, e.message, true);
  } finally { if ($("dCheck")) $("dCheck").disabled = false; }
}

function renderListings(c) {
  const ls = c.listings || [];
  const box = $("dListings"); if (!box || !ls.length) return;
  let filter = "match";
  const draw = () => {
    const show = ls.filter((l) => filter === "all" ? true : filter === "unknown" ? l.status === "unknown" : filter === "other" ? l.status === "other" : l.status === "match");
    box.innerHTML = `<div class="filters" role="group" aria-label="Filter listings">
      ${[["match", "Matches " + condLabel(c)], ["other", "Other conditions"], ["unknown", "Not stated"], ["all", "All"]].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${esc(t)}</button>`).join("")}</div>
      <ul class="listings">${show.slice(0, 40).map((l) => `<li>
        ${l.url ? `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>` : `<span>${esc(l.title)}</span>`}
        <span class="p">${money(l.price, "CAD")}${l.orig && l.orig.currency !== "CAD" ? `<br><span class="muted">${esc(money(Number(l.orig.value), l.orig.currency))}</span>` : ""}</span>
        <span class="c"><span class="tag">${l.kind === "sold" ? "Sold" + (l.date ? " " + fmtDate(l.date) : "") : "Listed"}</span>
        <span class="tag">${esc(l.source === "130point" ? "130point" : l.site)}</span>
        <span class="tag ${l.status === "match" ? "match" : l.status === "unknown" ? "unknown" : ""}">${esc(l.status === "excluded" ? "skipped: " + l.reason : l.cond || "condition not stated")}</span>
        ${l.src && l.src !== "title" ? `<span class="tag">from ${esc(l.src)}</span>` : ""}</span></li>`).join("") || `<li><span class="muted small">Nothing in this group.</span></li>`}</ul>
      <p class="small muted">Checked ${ago(c.ebay?.at || c.p130?.at)} · search “${esc(c.ebay?.query || c.p130?.query || "")}” · prices converted to CAD${rates?.source ? ` using ${esc(rates.source)}` : ""}. Asking prices are what sellers want, not what cards sold for.</p>`;
    box.querySelector(".filters").onclick = (e) => { const b = e.target.closest("button"); if (b) { filter = b.dataset.f; draw(); } };
  };
  draw();
}
function fmtDate(d) { const t = new Date(d); return isFinite(t) ? t.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : String(d).slice(0, 10); }

/* ---------------- Update prices (TCGplayer) ---------------- */
$("btnRefresh").addEventListener("click", async () => {
  const st = $("binderStatus"), btn = $("btnRefresh");
  const withId = cards.filter((c) => c.tcgId);
  if (!withId.length) return setStatus(st, "No cards linked to the card database yet.");
  btn.disabled = true;
  try {
    if (!rates) rates = await helper("/rates", {}).catch(() => null);
    for (let i = 0; i < withId.length; i += 20) {
      setStatus(st, `Updating prices… ${Math.min(i + 20, withId.length)} of ${withId.length}`);
      const batch = withId.slice(i, i + 20);
      const res = await tcgSearch(batch.map((c) => `id:${c.tcgId}`).join(" OR "), { pageSize: 20, orderBy: "name" });
      for (const api of res) for (const c of batch.filter((x) => x.tcgId === api.id)) {
        const keep = { binderId: c.binderId, language: c.language, qty: c.qty, condType: c.condType, condition: c.condition, grader: c.grader, grade: c.grade, notes: c.notes, photo: c.photo, variant: c.variant };
        Object.assign(c, fromApi(api), keep);
      }
    }
    await store.putMany("cards", withId); renderBinder();
    setStatus(st, `TCGplayer prices updated for ${withId.length} cards${rates ? ", converted to CAD" : ""}. Open a card and tap Check prices for sold prices by condition.`);
  } catch (e) { setStatus(st, e.message, true); }
  finally { btn.disabled = false; }
});

/* ---------------- Settings ---------------- */
$("setWorker").value = settings.get("worker");
$("setKey").value = settings.get("tcgKey");
$("setWorker").addEventListener("change", (e) => settings.set("worker", e.target.value.trim()));
$("setKey").addEventListener("change", (e) => settings.set("tcgKey", e.target.value.trim()));
$("btnTestWorker").addEventListener("click", async () => {
  settings.set("worker", $("setWorker").value.trim());
  const st = $("workerStatus"); setStatus(st, "Testing…");
  try {
    const h = await helper("/health", {});
    const sites = Object.values(h.markets || {}).map((m) => `${m.site} ${m.ok ? "✓" : "✗"}`).join(", ");
    const jt = h.justtcg || {};
    const bits = [`JustTCG: ${jt.ok ? `working (${jt.version}, ${jt.variants} variants for the test card${jt.graded ? ", graded included" : ", no graded variants"}${jt.remaining != null ? `, ${jt.remaining} calls left` : ""})` : jt.error}.`,
      `eBay sites: ${sites}.`, `Sold prices: ${h.insights ? "working" : "not approved yet"}.`,
      `Exchange rates: ${h.rates ? h.ratesSource : "not working"}.`,
      `130point: contact ${h.p130?.contact}, key ${h.p130?.key}, ${h.p130?.usedToday}/${h.p130?.dailyCap} used today${h.p130?.pausedUntil ? `, paused until ${h.p130.pausedUntil}` : ""}.`];
    setStatus(st, bits.join(" "), !h.browse);
    if (h.ratesTable) rates = { rates: h.ratesTable, source: h.ratesSource };
  } catch (e) { setStatus(st, e.code === "no_worker" ? "Paste your price helper address first." : `Couldn't reach the helper. Check the address and that this site is listed in ALLOWED_ORIGINS. (${e.message})`, true); }
});
$("btnTestNames").addEventListener("click", async () => {
  const st = $("namesStatus"); setStatus(st, "Loading the name list…");
  try {
    const loaded = await N.load(true);
    const sample = N.lookup("リザードン", loaded);
    setStatus(st, `Loaded ${Object.keys(loaded.map).length.toLocaleString()} names from ${loaded.source}. Test lookup リザードン → ${sample ? sample.en : "no match"}.`, !sample);
  } catch (e) { setStatus(st, e.message + " Japanese, Korean and Chinese cards can still be added by typing the English name.", true); }
});

/* Backup */
$("btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ app: "binder-scan", version: APP_VERSION, exported: new Date().toISOString(), binders, cards }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `binder-scan-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus($("backupStatus"), `Exported ${cards.length} cards in ${binders.length} binder${binders.length === 1 ? "" : "s"}.`);
});
$("importInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const st = $("backupStatus");
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(list)) throw new Error("bad");
    if (Array.isArray(data.binders)) {
      const have = new Set(binders.map((b) => b.id));
      const add = data.binders.filter((b) => b && b.id && !have.has(b.id));
      if (add.length) { binders.push(...add); await store.putMany("binders", add); }
    }
    const haveCards = new Set(cards.map((c) => c.id));
    const incoming = list.map(normalizeImported).filter((c) => c.name && !haveCards.has(c.id));
    for (const c of incoming) if (!binders.some((b) => b.id === c.binderId)) c.binderId = DEFAULT_BINDER;
    await store.putMany("cards", incoming); cards = [...incoming, ...cards]; renderBinder();
    setStatus(st, `Imported ${incoming.length} cards. Matching card art…`);
    let matched = 0;
    for (const c of incoming.filter((x) => !x.tcgId)) {
      try {
        const res = await findCards(parseQuery([c.name, c.number && c.printedTotal ? `${c.number}/${c.printedTotal}` : c.number].filter(Boolean).join(" ")));
        const best = res[0];
        if (best && lev(best.name, c.name) >= 0.75 && (!c.number || cleanNum(String(c.number)) === best.number)) {
          const keepVariant = c.variant, keep = { binderId: c.binderId, language: c.language, qty: c.qty, condType: c.condType, condition: c.condition, grader: c.grader, grade: c.grade, notes: c.notes, photo: c.photo };
          Object.assign(c, fromApi(best), keep);
          const vs = variantsFor(best); c.variant = vs.includes(keepVariant) ? keepVariant : guessVariant(keepVariant, vs);
          await store.put("cards", c); matched++;
        }
      } catch {}
    }
    renderBinder();
    const left = incoming.filter((x) => !x.tcgId).length;
    setStatus(st, `Imported ${incoming.length} cards. Card art added to ${matched}.${left ? ` ${left} need a manual match: open the card and tap Find official card.` : ""}`);
  } catch { setStatus(st, "That file isn't a Binder Scan backup.", true); }
});
function guessVariant(label, vs) {
  const l = String(label || "").toLowerCase();
  if (l.includes("1st")) return vs.find((v) => v.startsWith("1st")) || vs[0];
  if (l.includes("reverse")) return vs.includes("reverseHolofoil") ? "reverseHolofoil" : vs[0];
  if (l.includes("shadowless")) return "shadowless";
  if (l.includes("holo")) return vs.find((v) => /holofoil/i.test(v) && !/reverse|1st/i.test(v)) || vs[0];
  return vs[0];
}
function normalizeImported(x) {
  const c = { ...x };
  c.id = c.id || c._id || uid();
  if (!c.setName && c.set && typeof c.set === "string") c.setName = c.set;
  if (c.number && String(c.number).includes("/")) { const [n, t] = String(c.number).split("/"); c.number = cleanNum(n.trim()); c.printedTotal = c.printedTotal || parseInt(t, 10) || t; }
  if (!c.photo && c.thumb) c.photo = c.thumb;
  if (c.condType === "graded" && !c.grader && typeof c.condition === "string") {
    const m = c.condition.match(/^(\w+)\s+(.+)$/); if (m) { c.grader = m[1]; c.grade = m[2]; c.condition = null; }
  }
  c.condType = c.condType || "raw"; c.qty = c.qty || 1; c.added = c.added || Date.now();
  c.language = LANGS.includes(c.language) ? c.language : "English";
  c.binderId = c.binderId || DEFAULT_BINDER;
  delete c._id; delete c.thumb; delete c.set; delete c.example;
  return c;
}

/* ---------------- Tabs, install, boot ---------------- */
function go(tab) {
  for (const v of ["scan", "binder", "settings"]) $("view-" + v).hidden = v !== tab;
  document.querySelectorAll(".tabs button").forEach((b) => (b.dataset.go === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  $("main").scrollTop = 0;
  if (tab === "binder") renderBinder();
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go); });

let installEvt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); installEvt = e;
  if ($("installBtn")) return;
  const btn = Object.assign(document.createElement("button"), { id: "installBtn", className: "btn primary", textContent: "Install Binder Scan on this phone" });
  btn.onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; btn.remove(); };
  $("view-scan").prepend(btn);
});

(async function boot() {
  try {
    cards = await store.all("cards");
    binders = await store.all("binders");
  } catch { toast("Storage is blocked in this browser. Cards won't be saved."); }
  if (!binders.length) {
    binders = [{ id: DEFAULT_BINDER, name: "My collection", cover: null, created: Date.now() }];
    await store.put("binders", binders[0]).catch(() => {});
  }
  binders.sort((a, b) => (a.created || 0) - (b.created || 0));
  let changed = cards.filter((c) => !c.binderId || !c.language);
  if (changed.length) { changed.forEach((c) => { c.binderId = c.binderId || DEFAULT_BINDER; c.language = c.language || "English"; }); await store.putMany("cards", changed).catch(() => {}); }
  cards.sort((a, b) => (b.added || 0) - (a.added || 0));
  currentBinder = binders.some((b) => b.id === settings.get("binder")) ? settings.get("binder") : binders[0].id;
  renderBinder();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (navigator.storage?.estimate) navigator.storage.estimate().then((e) => ($("storageInfo").textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this phone. App version ${APP_VERSION}.`)).catch(() => {});
  if (cards.length) go("binder");
  if (workerBase()) helper("/rates", {}).then((r) => (rates = r)).catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
