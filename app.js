/* Binder Scan — installable Pokémon card collection app.
   Card data/images: Pokémon TCG API (api.pokemontcg.io). eBay: your own Cloudflare Worker (see setup guide). */
"use strict";

const APP_VERSION = "2.0.0";
const TCG_API = "https://api.pokemontcg.io/v2";
const TCG_SELECT = "id,name,number,rarity,set,images,tcgplayer,supertype";
const C = window.BinderConditions;

/* ---------------- small helpers ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const CUR = { USD: "US$", CAD: "C$", EUR: "€", GBP: "£" };
function money(v, cur = "USD") {
  if (v == null || !isFinite(v)) return "—";
  const sym = CUR[cur] || cur + " ";
  return sym + (v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2));
}
function setStatus(el, msg, err) { el.hidden = !msg; el.textContent = msg || ""; el.classList.toggle("err", !!err); }
let toastTimer;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600); }
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

/* ---------------- settings ---------------- */
const settings = {
  get(k, d = "") { try { return localStorage.getItem("bs." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("bs." + k, v); } catch {} },
};

/* ---------------- storage (IndexedDB) ---------------- */
const store = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("binderscan", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("cards", { keyPath: "id" });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("cards", mode); const s = t.objectStore("cards");
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    all: () => tx("readonly", (s) => s.getAll()),
    put: (c) => tx("readwrite", (s) => { s.put(c); }),
    putMany: (cs) => tx("readwrite", (s) => { cs.forEach((c) => s.put(c)); }),
    del: (id) => tx("readwrite", (s) => { s.delete(id); }),
  };
})();

let cards = [];
async function saveCard(c) { const i = cards.findIndex((x) => x.id === c.id); if (i >= 0) cards[i] = c; else cards.unshift(c); await store.put(c); renderBinder(); }
async function deleteCard(id) { cards = cards.filter((c) => c.id !== id); await store.del(id); renderBinder(); }

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
    releaseDate: api.set?.releaseDate, setSymbol: api.set?.images?.symbol,
    img: { small: api.images?.small, large: api.images?.large },
    tcg: api.tcgplayer ? { url: api.tcgplayer.url, updatedAt: api.tcgplayer.updatedAt, prices: api.tcgplayer.prices || {} } : null,
  };
}
const numLabel = (c) => (c.number ? (c.printedTotal && /^\d+$/.test(String(c.number)) ? `${c.number}/${c.printedTotal}` : c.number) : "");
function tcgMarket(c) {
  const p = c.tcg?.prices || {};
  const v = p[c.variant] || p.holofoil || p.normal || Object.values(p)[0];
  return v ? v.market ?? v.mid ?? null : null;
}

/* Query building: "charizard 4/102", "4/102", "dark blastoise" */
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

/* ---------------- OCR (Tesseract.js, loaded on first scan) ---------------- */
let ocrWorkerP = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("load")); document.head.appendChild(s); });
}
function getOcr() {
  if (!ocrWorkerP) {
    ocrWorkerP = (async () => {
      if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
      const w = await Tesseract.createWorker("eng");
      await w.setParameters({ tessedit_pageseg_mode: "11" });
      return w;
    })().catch((e) => { ocrWorkerP = null; throw e; });
  }
  return ocrWorkerP;
}
function loadImage(file) {
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
/* Crop a band of the photo (fractions), upscale, grayscale and stretch contrast for OCR. */
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
async function readCard(file, onStep) {
  const img = await loadImage(file);
  onStep("Loading the text reader (first time takes a moment)…");
  const w = await getOcr();
  onStep("Reading the card name…");
  const top = await w.recognize(band(img, 0.04, 0.02, 0.72, 0.12));
  onStep("Reading the card number…");
  const bottom = await w.recognize(band(img, 0, 0.86, 1, 0.13));
  let nb = numberFrom(bottom.data.text);
  if (!nb) {
    onStep("Looking a little harder…");
    const full = await w.recognize(band(img, 0, 0, 1, 1, 1600));
    nb = numberFrom(full.data.text);
  }
  URL.revokeObjectURL(img.src);
  return { name: nameFrom(top.data.text), num: nb?.num || null, total: nb?.total || null };
}
function makeThumb(file) {
  return loadImage(file).then((img) => {
    const w = 240, h = Math.round((w * 88) / 63), cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const x = cv.getContext("2d"), r = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * r, dh = img.naturalHeight * r; x.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    URL.revokeObjectURL(img.src); return cv.toDataURL("image/jpeg", 0.72);
  }).catch(() => null);
}

/* ---------------- Scan view ---------------- */
let scan = { file: null, thumb: null };
async function onPhoto(file) {
  if (!file) return;
  scan = { file, thumb: null };
  const p = $("preview"); p.src = URL.createObjectURL(file); p.hidden = false; $("frameEmpty").hidden = true;
  $("frame").classList.add("has-photo", "scanning");
  $("resultsWrap").hidden = true;
  scan.thumb = await makeThumb(file);
  try {
    const read = await readCard(file, (m) => setStatus($("scanStatus"), m));
    const said = [read.name, read.num && read.total ? `${read.num}/${read.total}` : read.num].filter(Boolean).join(" ");
    $("q").value = said;
    if (!read.name && !read.num) {
      setStatus($("scanStatus"), "Couldn't read the name or number. Type it in the search box above, for example “charizard 4/102”.", true);
      return;
    }
    setStatus($("scanStatus"), `Read “${said}”. Searching…`);
    await runSearch(read, said);
  } catch (e) {
    setStatus($("scanStatus"), e.message === "load" ? "The text reader couldn't load. Check your connection, or search by name instead." : e.message || "Reading failed. Search by name instead.", true);
  } finally { $("frame").classList.remove("scanning"); }
}
async function runSearch(parsed, label) {
  try {
    const res = await findCards(parsed);
    renderPicks(res, (api) => openAddSheet(api));
    setStatus($("scanStatus"), res.length ? `${res.length} possible match${res.length === 1 ? "" : "es"} for “${label}”. Tap yours.` : `No cards found for “${label}”. Check the spelling or try just the name.`, !res.length);
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
$("camInput").addEventListener("change", (e) => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("galInput").addEventListener("change", (e) => { onPhoto(e.target.files[0]); e.target.value = ""; });
$("searchForm").addEventListener("submit", (e) => {
  e.preventDefault(); const v = $("q").value.trim(); if (!v) return;
  setStatus($("scanStatus"), "Searching…"); runSearch(parseQuery(v), v);
});

/* ---------------- Condition editor (shared) ---------------- */
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

/* ---------------- Sheet ---------------- */
function openSheet(html) { $("sheetBody").innerHTML = html; $("sheet").hidden = false; $("sheet").querySelector(".sheet-panel").scrollTop = 0; }
function closeSheet() { $("sheet").hidden = true; $("sheetBody").innerHTML = ""; }
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

function openAddSheet(api) {
  const base = fromApi(api);
  const variants = variantsFor(api);
  const state = { condType: "raw", condition: "NM" };
  openSheet(`
    <div class="hero"><img src="${esc(base.img.large || base.img.small)}" alt="${esc(base.name)}">
      <div><span class="label">${esc(base.setName)} · ${esc(numLabel(base))}</span><h2 id="sheetTitle">${esc(base.name)}</h2>
      <span class="small muted">${esc([base.rarity, base.series, (base.releaseDate || "").slice(0, 4)].filter(Boolean).join(" · "))}</span>
      ${tcgMarket({ ...base, variant: variants[0] }) ? `<span class="small">TCGplayer market <b class="mono">${money(tcgMarket({ ...base, variant: variants[0] }))}</b></span>` : ""}</div></div>
    <div class="fields">
      <div class="f"><label for="aVariant">Version</label><select id="aVariant">${variants.map((v) => `<option value="${v}">${esc(variantLabel(v))}</option>`).join("")}</select></div>
      <div class="f"><label for="aQty">Quantity</label><input id="aQty" type="number" min="1" value="1" class="mono" inputmode="numeric"></div>
    </div>
    ${condEditorHTML(state)}
    <div class="f"><label for="aNotes">Notes</label><input id="aNotes" placeholder="Centering, whitening, surface…"></div>
    ${scan.thumb ? `<label class="small"><input type="checkbox" id="aKeepPhoto" checked style="width:auto"> Keep my photo with this card</label>` : ""}
    <div class="row"><button class="primary" id="aSave">Add to binder</button><button id="aCancel">Cancel</button></div>`);
  const getCond = wireCondEditor(state);
  $("aCancel").onclick = closeSheet;
  $("aSave").onclick = async () => {
    const card = { id: uid(), ...base, variant: $("aVariant").value, qty: Math.max(1, parseInt($("aQty").value, 10) || 1), ...getCond(),
      notes: $("aNotes").value.trim(), photo: $("aKeepPhoto")?.checked ? scan.thumb : null, added: Date.now(), ebay: null };
    await saveCard(card); closeSheet();
    toast(`Added ${card.name} (${condLabel(card)})`);
    resetScan();
  };
}
function resetScan() {
  scan = { file: null, thumb: null }; $("preview").hidden = true; $("frameEmpty").hidden = false; $("frame").classList.remove("has-photo");
  $("resultsWrap").hidden = true; $("q").value = ""; setStatus($("scanStatus"), "");
}

/* ---------------- Value ---------------- */
function cardValue(c) {
  const s = c.ebay?.sold, a = c.ebay?.active;
  if (s?.median) return { v: s.median, cur: s.cur, src: "eBay sold" };
  if (a?.median) return { v: a.median, cur: a.cur, src: "eBay asking" };
  if (c.condType !== "graded") { const t = tcgMarket(c); if (t) return { v: t, cur: "USD", src: "TCGplayer" }; }
  return null;
}

/* ---------------- Binder view ---------------- */
function renderBinder() {
  const total = cards.reduce((a, c) => a + (c.qty || 1), 0);
  $("hdrCount").textContent = `${total} card${total === 1 ? "" : "s"}`;
  $("sCards").textContent = total; $("sUnique").textContent = `${cards.length} unique`;
  $("sGraded").textContent = cards.filter((c) => c.condType === "graded").reduce((a, c) => a + (c.qty || 1), 0);
  const sums = {}, srcs = {}; let unpriced = 0;
  for (const c of cards) { const v = cardValue(c); if (!v) { unpriced++; continue; } sums[v.cur] = (sums[v.cur] || 0) + v.v * (c.qty || 1); srcs[v.src] = (srcs[v.src] || 0) + 1; }
  const curKeys = Object.keys(sums);
  $("sValue").textContent = curKeys.length ? curKeys.map((k) => money(sums[k], k)).join(" + ") : "—";
  $("sValueNote").textContent = [Object.entries(srcs).map(([k, n]) => `${n} via ${k}`).join(", "), unpriced ? `${unpriced} unpriced` : ""].filter(Boolean).join(" · ");

  const q = $("filter").value.trim().toLowerCase(), sort = $("sort").value;
  let list = cards.filter((c) => !q || [c.name, c.setName, c.number, numLabel(c)].join(" ").toLowerCase().includes(q));
  const cmp = {
    new: (a, b) => (b.added || 0) - (a.added || 0),
    name: (a, b) => a.name.localeCompare(b.name),
    set: (a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "") || (parseInt(a.number) || 0) - (parseInt(b.number) || 0),
    value: (a, b) => (cardValue(b)?.v || 0) - (cardValue(a)?.v || 0),
  }[sort];
  list.sort(cmp);
  $("empty").hidden = cards.length > 0;
  $("binder").innerHTML = list.map((c) => {
    const v = cardValue(c);
    const art = c.img?.small
      ? `<img src="${esc(c.img.small)}" alt="${esc(c.name)}" loading="lazy" data-fallback="${c.photo ? "1" : ""}">`
      : c.photo ? `<img src="${esc(c.photo)}" alt="${esc(c.name)}">` : `<span class="ph"></span><span class="ph-name">${esc(c.name)}</span>`;
    return `<li><button class="pocket" data-id="${esc(c.id)}">
      <span class="art">${art}<span class="chip ${condClass(c)}">${esc(condLabel(c))}</span>${c.qty > 1 ? `<span class="qty">×${c.qty}</span>` : ""}</span>
      <span class="nm">${esc(c.name)}</span>
      <span class="meta">${esc(c.setName || "")} · ${esc(numLabel(c))}</span>
      <span class="price">${v ? money(v.v, v.cur) : "<span class='muted'>no price</span>"}</span>
    </button></li>`;
  }).join("");
  // Official art failed to load -> fall back to the user's photo, then to a named placeholder.
  $("binder").querySelectorAll("img[data-fallback]").forEach((img) => {
    img.addEventListener("error", () => {
      const c = cards.find((x) => x.id === img.closest(".pocket").dataset.id);
      if (c?.photo && img.src !== c.photo) img.src = c.photo;
      else img.replaceWith(Object.assign(document.createElement("span"), { className: "ph" }));
    }, { once: false });
  });
}
$("filter").addEventListener("input", renderBinder);
$("sort").addEventListener("change", renderBinder);
$("binder").addEventListener("click", (e) => { const b = e.target.closest(".pocket"); if (b) openCardSheet(b.dataset.id); });

/* ---------------- Card detail ---------------- */
function openCardSheet(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  const state = { condType: c.condType, condition: c.condition };
  const tm = tcgMarket(c);
  const img = c.img?.large || c.img?.small || c.photo || "";
  const variants = c.tcg ? [...new Set([...(Object.keys(c.tcg.prices || {})), c.setId === "base1" ? "shadowless" : null, "other", c.variant].filter(Boolean))] : [c.variant || "other"];
  openSheet(`
    <div class="hero">${img ? `<img id="dImg" src="${esc(img)}" alt="${esc(c.name)}">` : `<span></span>`}
      <div><span class="label">${esc(c.setName || "Unknown set")} · ${esc(numLabel(c))}</span><h2 id="sheetTitle">${esc(c.name)}</h2>
      <span class="small muted">${esc([c.rarity, variantLabel(c.variant), (c.releaseDate || "").slice(0, 4)].filter(Boolean).join(" · "))}</span>
      ${c.photo && c.img?.small ? `<div class="photo-toggle"><button id="dArt" aria-pressed="true">Card art</button><button id="dPhoto" aria-pressed="false">My photo</button></div>` : ""}
      ${!c.tcgId ? `<button id="dMatch" class="primary">Find official card</button>` : ""}</div></div>

    <div class="panel" id="valuePanel">
      <div class="section-head"><h3>Value</h3><span class="small muted" id="dValSrc"></span></div>
      <div class="big-num" id="dVal">—</div>
      <div class="kv">
        <span>TCGplayer market${c.condType === "graded" ? " (raw)" : ""}</span><span class="v">${tm ? (c.tcg?.url ? `<a href="${esc(c.tcg.url)}" target="_blank" rel="noopener">${money(tm)}</a>` : money(tm)) : "—"}</span>
        <span>eBay sold, ${esc(condLabel(c))}</span><span class="v" id="dSold">${ebaySummary(c.ebay?.sold)}</span>
        <span>eBay asking, ${esc(condLabel(c))}</span><span class="v" id="dAct">${ebaySummary(c.ebay?.active)}</span>
      </div>
      <button id="dEbay">${c.ebay ? "Re-check eBay" : "Check eBay"}</button>
      <div class="status" id="dEbayStatus" hidden></div>
      <div id="dListings"></div>
    </div>

    <div class="fields">
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
  $("dVal").textContent = val ? money(val.v, val.cur) : "—";
  $("dValSrc").textContent = val ? `from ${val.src}` : "no price yet";
  if ($("dArt")) {
    $("dArt").onclick = () => { $("dImg").src = c.img.large || c.img.small; $("dArt").setAttribute("aria-pressed", true); $("dPhoto").setAttribute("aria-pressed", false); };
    $("dPhoto").onclick = () => { $("dImg").src = c.photo; $("dPhoto").setAttribute("aria-pressed", true); $("dArt").setAttribute("aria-pressed", false); };
  }
  if ($("dMatch")) $("dMatch").onclick = () => openMatchSheet(c.id);
  $("dEbay").onclick = () => checkEbay(c.id);
  $("dSave").onclick = async () => {
    const before = condLabel(c) + c.variant;
    Object.assign(c, getCond(), { variant: $("dVariant").value, qty: Math.max(1, parseInt($("dQty").value, 10) || 1), notes: $("dNotes").value.trim() });
    if (condLabel(c) + c.variant !== before) c.ebay = null; // old eBay numbers were for another condition
    await saveCard(c); closeSheet(); toast("Saved");
  };
  $("dDel").onclick = () => ($("dConfirm").hidden = false);
  $("dNo").onclick = () => ($("dConfirm").hidden = true);
  $("dYes").onclick = async () => { await deleteCard(c.id); closeSheet(); toast("Removed"); };
  $("dClose").onclick = closeSheet;
  if (c.ebay?.listings) renderListings(c);
}
function ebaySummary(s) {
  if (!s) return "—";
  if (s.error === "not_approved") return "<span class='muted'>needs eBay approval</span>";
  if (s.error) return "<span class='muted'>unavailable</span>";
  if (!s.median) return `<span class='muted'>none found</span>`;
  return `${money(s.median, s.cur)} <span class="muted small">(${s.n})</span>`;
}

/* Attach official card data to a card that came in without it (old backups). */
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
        Object.assign(c, fromApi(api)); const vs = variantsFor(api); if (!vs.includes(c.variant)) c.variant = vs[0]; c.ebay = null;
        await saveCard(c); openCardSheet(c.id); toast("Card art added");
      }, $("mResults"), $("mWrap"));
      setStatus($("mStatus"), res.length ? "Tap the right card." : "Nothing found. Edit the search and try again.", !res.length);
    } catch (e) { setStatus($("mStatus"), e.message, true); }
  };
  $("mForm").onsubmit = (e) => { e.preventDefault(); go(); };
  go();
}

/* ---------------- eBay (through the user's Worker) ---------------- */
function workerBase() { return settings.get("worker").trim().replace(/\/+$/, ""); }
async function ebayCall(path, params) {
  const base = workerBase();
  if (!base) throw Object.assign(new Error("Add your eBay helper address in Settings first."), { code: "no_worker" });
  const r = await fetch(`${base}${path}?${new URLSearchParams(params)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `eBay helper error ${r.status}`), { code: j.error || "http_" + r.status });
  return j;
}
function ebayQuery(c) {
  const name = c.name.replace(/[^\p{L}\p{N}\s'-]/gu, " ").trim();
  const parts = [name, numLabel(c) || c.number];
  if (c.variant && /1st/i.test(c.variant)) parts.push("1st edition");
  if (c.variant === "shadowless") parts.push("shadowless");
  if (c.variant === "reverseHolofoil") parts.push("reverse");
  if (c.condType === "graded") parts.push(c.grader, String(c.grade).replace(/^(Pristine|Black Label) /, ""));
  return parts.filter(Boolean).join(" ");
}
function summarize(items, card, priceKey) {
  const parsed = items.map((it) => ({ it, r: C.parseListing(it, card) }));
  const matched = parsed.filter((p) => p.r.status === "match");
  const prices = matched.map((p) => Number(p.it[priceKey]?.value)).filter((n) => n > 0);
  const st = C.robustStats(prices);
  const cur = matched[0]?.it[priceKey]?.currency || items[0]?.[priceKey]?.currency || "USD";
  return { parsed, stats: st ? { median: st.median, low: st.low, high: st.high, n: st.n, dropped: st.dropped, cur, at: Date.now() } : { median: null, n: 0, cur, at: Date.now() } };
}
async function describeUnknowns(parsed, card, max = 6) {
  const unknown = parsed.filter((p) => p.r.status === "unknown" && p.it.itemId).slice(0, max);
  await Promise.all(unknown.map(async (p) => {
    try {
      const d = await ebayCall("/item", { id: p.it.itemId, market: settings.get("market", "EBAY_US") });
      Object.assign(p.it, { description: d.description, descriptors: d.descriptors, conditionId: d.conditionId ?? p.it.conditionId });
      p.r = C.parseListing(p.it, card);
    } catch {}
  }));
}
async function checkEbay(id) {
  const c = cards.find((x) => x.id === id); if (!c) return;
  const st = $("dEbayStatus"); $("dEbay").disabled = true;
  setStatus(st, "Checking eBay…");
  const market = settings.get("market", "EBAY_US");
  const params = { q: ebayQuery(c), market, cond: c.condType === "graded" ? "graded" : "raw" };
  try {
    const [act, sold] = await Promise.allSettled([ebayCall("/active", params), ebayCall("/sold", params)]);
    if (act.status === "rejected" && act.reason.code === "no_worker") throw act.reason;
    const ebay = { at: Date.now(), query: params.q, listings: [] };
    if (act.status === "fulfilled") {
      const s = summarize(act.value.items || [], c, "price");
      await describeUnknowns(s.parsed, c);
      const s2 = summarize(s.parsed.map((p) => p.it), c, "price");
      ebay.active = s2.stats;
      ebay.listings.push(...s2.parsed.map((p) => slim(p, "active", "price")));
    } else ebay.active = { error: act.reason.code || "error" };
    if (sold.status === "fulfilled") {
      const s = summarize(sold.value.items || [], c, "lastSoldPrice");
      ebay.sold = s.stats;
      ebay.listings.unshift(...s.parsed.map((p) => slim(p, "sold", "lastSoldPrice")));
    } else ebay.sold = { error: sold.reason.code || "error" };
    c.ebay = ebay; await saveCard(c);
    const counts = ebay.listings.reduce((a, l) => ((a[l.status] = (a[l.status] || 0) + 1), a), {});
    setStatus(st, `${ebay.listings.length} listings checked: ${counts.match || 0} match ${condLabel(c)}, ${counts.other || 0} other condition, ${counts.unknown || 0} condition not stated, ${counts.excluded || 0} skipped.` +
      (ebay.sold?.error === "not_approved" ? " Sold prices need eBay's Marketplace Insights approval." : ""));
    openCardSheetKeepStatus(c.id, st.textContent);
  } catch (e) {
    setStatus(st, e.message, true);
  } finally { if ($("dEbay")) $("dEbay").disabled = false; }
}
function slim(p, kind, priceKey) {
  return { kind, status: p.r.status, cond: p.r.cond?.label || null, src: p.r.cond?.source || null, reason: p.r.reason || null,
    title: p.it.title, url: p.it.itemWebUrl, price: Number(p.it[priceKey]?.value) || null, cur: p.it[priceKey]?.currency,
    date: p.it.lastSoldDate || null };
}
function openCardSheetKeepStatus(id, msg) { openCardSheet(id); setStatus($("dEbayStatus"), msg); }
function renderListings(c) {
  const ls = c.ebay.listings || [];
  const box = $("dListings"); if (!box || !ls.length) return;
  let filter = "match";
  const draw = () => {
    const show = ls.filter((l) => filter === "all" ? true : filter === "unknown" ? l.status === "unknown" : filter === "other" ? l.status === "other" : l.status === "match");
    box.innerHTML = `<div class="filters" role="group" aria-label="Filter listings">
      ${[["match", "Matches " + condLabel(c)], ["other", "Other conditions"], ["unknown", "Not stated"], ["all", "All"]].map(([k, t]) => `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${esc(t)}</button>`).join("")}</div>
      <ul class="listings">${show.slice(0, 40).map((l) => `<li>
        <a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a><span class="p">${money(l.price, l.cur)}</span>
        <span class="c"><span class="tag">${l.kind === "sold" ? "Sold" + (l.date ? " " + new Date(l.date).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "") : "Listed"}</span>
        <span class="tag ${l.status === "match" ? "match" : l.status === "unknown" ? "unknown" : ""}">${esc(l.status === "excluded" ? "skipped: " + l.reason : l.cond || "condition not stated")}</span>
        ${l.src && l.src !== "title" ? `<span class="tag">from ${esc(l.src)}</span>` : ""}</span></li>`).join("") || `<li><span class="muted small">Nothing in this group.</span></li>`}</ul>
      <p class="small muted">Checked ${ago(c.ebay.at)} · search “${esc(c.ebay.query)}”. Asking prices are what sellers want, not what cards sold for.</p>`;
    box.querySelector(".filters").onclick = (e) => { const b = e.target.closest("button"); if (b) { filter = b.dataset.f; draw(); } };
  };
  draw();
}

/* ---------------- Update prices (TCGplayer via Pokémon TCG API) ---------------- */
$("btnRefresh").addEventListener("click", async () => {
  const st = $("binderStatus"), btn = $("btnRefresh");
  const withId = cards.filter((c) => c.tcgId);
  if (!withId.length) return setStatus(st, "No cards linked to the card database yet.");
  btn.disabled = true;
  try {
    for (let i = 0; i < withId.length; i += 20) {
      setStatus(st, `Updating prices… ${Math.min(i + 20, withId.length)} of ${withId.length}`);
      const batch = withId.slice(i, i + 20);
      const res = await tcgSearch(batch.map((c) => `id:${c.tcgId}`).join(" OR "), { pageSize: 20, orderBy: "name" });
      for (const api of res) for (const c of batch.filter((x) => x.tcgId === api.id)) Object.assign(c, fromApi(api));
    }
    await store.putMany(withId); renderBinder();
    setStatus(st, `TCGplayer prices updated for ${withId.length} cards. Open a card and tap Check eBay for prices by condition.`);
  } catch (e) { setStatus(st, e.message, true); }
  finally { btn.disabled = false; }
});

/* ---------------- Settings ---------------- */
$("setWorker").value = settings.get("worker");
$("setMarket").value = settings.get("market", "EBAY_US");
$("setKey").value = settings.get("tcgKey");
$("setWorker").addEventListener("change", (e) => settings.set("worker", e.target.value.trim()));
$("setMarket").addEventListener("change", (e) => settings.set("market", e.target.value));
$("setKey").addEventListener("change", (e) => settings.set("tcgKey", e.target.value.trim()));
$("btnTestWorker").addEventListener("click", async () => {
  settings.set("worker", $("setWorker").value.trim());
  const st = $("workerStatus"); setStatus(st, "Testing…");
  try {
    const h = await ebayCall("/health", { market: $("setMarket").value });
    setStatus(st, `Connected. Current listings: ${h.browse ? "working" : "not working (" + (h.browseError || "check keys") + ")"}. Sold prices: ${h.insights ? "working" : "not approved yet"}.`, !h.browse);
  } catch (e) { setStatus(st, e.code === "no_worker" ? "Paste your eBay helper address first." : `Couldn't reach the helper. Check the address and that this site is listed in ALLOWED_ORIGINS. (${e.message})`, true); }
});

/* Backup */
$("btnExport").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ app: "binder-scan", version: APP_VERSION, exported: new Date().toISOString(), cards }, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = `binder-scan-backup-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  setStatus($("backupStatus"), `Exported ${cards.length} cards.`);
});
$("importInput").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f) return;
  const st = $("backupStatus");
  try {
    const data = JSON.parse(await f.text());
    const list = Array.isArray(data) ? data : data.cards;
    if (!Array.isArray(list)) throw new Error("bad");
    const have = new Set(cards.map((c) => c.id));
    const incoming = list.map(normalizeImported).filter((c) => c.name && !have.has(c.id));
    await store.putMany(incoming); cards = [...incoming, ...cards]; renderBinder();
    setStatus(st, `Imported ${incoming.length} cards. Matching card art…`);
    let matched = 0;
    for (const c of incoming.filter((x) => !x.tcgId)) {
      try {
        const res = await findCards(parseQuery([c.name, c.number && c.printedTotal ? `${c.number}/${c.printedTotal}` : c.number].filter(Boolean).join(" ")));
        const best = res[0];
        if (best && lev(best.name, c.name) >= 0.75 && (!c.number || cleanNum(String(c.number)) === best.number)) {
          const keepVariant = c.variant; Object.assign(c, fromApi(best));
          const vs = variantsFor(best); c.variant = vs.includes(keepVariant) ? keepVariant : guessVariant(keepVariant, vs);
          await store.put(c); matched++;
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
/* Accepts current backups and cards from the first Binder Scan (Claude artifact) version. */
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
  try { cards = await store.all(); } catch { toast("Storage is blocked in this browser. Cards won't be saved."); }
  cards.sort((a, b) => (b.added || 0) - (a.added || 0));
  renderBinder();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if (navigator.storage?.estimate) navigator.storage.estimate().then((e) => ($("storageInfo").textContent = `Using ${(e.usage / 1048576).toFixed(1)} MB on this phone. App version ${APP_VERSION}.`)).catch(() => {});
  if (cards.length) go("binder");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
