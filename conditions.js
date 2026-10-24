/* Binder Scan — reads card condition and language out of eBay / 130point listings.
   parseListing(listing, card) -> { status: "match"|"other"|"unknown"|"excluded", cond, reason }
   A listing is { title, conditionId, condition, descriptors:[{name, values:[...]}], description } */
(function (root) {
  "use strict";

  const RAW_ORDER = ["NM", "LP", "MP", "HP", "DMG"]; // best -> worst

  const GRADERS = [
    ["PSA", /\bpsa\b/],
    ["CGC", /\bcgc\b/],
    ["BGS", /\b(bgs|beckett)\b/],
    ["SGC", /\bsgc\b/],
    ["TAG", /\btag\b(?=\s*(grad|pristine|gem|10|9|8|7|6|5|4|3|2|1))/],
    ["ACE", /\bace\b(?=\s*(grad|10|9|8|7|6|5|4|3|2|1))/],
  ];

  const EXCLUDE = /\b(lot|lots|bundle|bulk|proxy|proxies|custom|orica|fan ?art|replica|reprint|fake|digital|code card|online code|you pick|pick your|choose your|random|mystery|repack|empty (slab|case)|slab only|case only|sticker|binder|sleeves?|playmat|jumbo|oversized?)\b/;
  const GRADE_HEDGE = /\b(ready|candidate|potential|worthy|quality|possible|possibly|maybe|could|would|should|grade ?able|gradeable|send ?in|submission|for grading|to grade|not graded|ungraded|raw)\b/;

  /* ---- language ---- */
  const LANGS = ["English", "Japanese", "Korean", "Chinese"];
  const LANG_WORDS = {
    Japanese: /\b(japanese|japan|jpn|jp)\b|日本語/,
    Korean: /\b(korean|korea|kor|kr)\b|한국/,
    Chinese: /\b(chinese|china|traditional chinese|simplified chinese|t-?chinese|s-?chinese|chn|cn|taiwan)\b/,
    English: /\b(english|eng|en)\b/,
  };
  /* Script ranges, for reading a scanned card rather than a listing. */
  const SCRIPTS = {
    kana: /[぀-ゟ゠-ヿ]/,
    hangul: /[가-힯ᄀ-ᇿ㄰-㆏]/,
    han: /[一-鿿㐀-䶿]/,
  };
  function detectScript(text) {
    const s = String(text || "");
    if (SCRIPTS.hangul.test(s)) return "Korean";
    if (SCRIPTS.kana.test(s)) return "Japanese";
    if (SCRIPTS.han.test(s)) return "Chinese";
    return null;
  }
  /* A listing's language: what it says, else what its title is written in, else English. */
  function listingLanguage(listing) {
    const d = listing.descriptors || [];
    const langSpec = d.find((e) => /language/i.test(String(e.name || "")));
    if (langSpec) {
      const v = String((langSpec.values || [])[0] || "").toLowerCase();
      for (const L of LANGS) if (LANG_WORDS[L].test(v)) return L;
    }
    const t = norm(listing.title);
    const raw = String(listing.title || "");
    const script = detectScript(raw);
    for (const L of ["Japanese", "Korean", "Chinese"]) if (LANG_WORDS[L].test(t)) return L;
    if (script) return script;
    if (LANG_WORDS.English.test(t)) return "English";
    return "English"; // unmarked listings are English by convention on eBay
  }

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[‐-―]/g, "-")
      .replace(/é/g, "e")
      .replace(/[^a-z0-9./+\- ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function graderFromText(text) {
    for (const [name, re] of GRADERS) if (re.test(text)) return name;
    return null;
  }

  function findGraded(t) {
    const g = graderFromText(t);
    if (!g) return null;
    const key = g === "BGS" ? "(?:bgs|beckett)" : g.toLowerCase();
    const re = new RegExp("\\b" + key + "\\b(?:\\s+[a-z]+){0,3}?\\s*(10|9\\.5|[1-9](?:\\.5)?)\\b");
    const m = t.match(re);
    if (!m) return null;
    const around = t.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25);
    if (GRADE_HEDGE.test(around)) return { hedged: true };
    let grade = m[1];
    let special = null;
    if (grade === "10") {
      if (/\bpristine\b/.test(t)) special = "Pristine";
      else if (/\bblack label\b/.test(t)) special = "Black Label";
      else if (/\bperfect\b/.test(t) && g === "CGC") special = "Perfect";
    }
    const label = special === "Pristine" ? `${g} Pristine 10` : special === "Black Label" ? `${g} Black Label 10` : special === "Perfect" ? `${g} Perfect 10` : `${g} ${grade}`;
    return { type: "graded", grader: g, grade: special ? `${special} 10` : grade, label };
  }

  const RAW_PATTERNS = [
    ["DMG", /\b(dmg|damaged|damage|creased?|creasing|water damage|torn|tear|ripped|bent|writing on|inked)\b/],
    ["HP", /\b(heavily played|heavy play|heavy wear|poor condition|poor)\b|(?<![0-9]\s?)\bhp\b(?!\s?[0-9])/],
    ["MP", /\b(mp|moderately played|moderate play|moderate wear|played|vg|very good)\b/],
    ["LP", /\b(lp|lightly played|light play|light wear|slightly played|sp|excellent|exc)\b/],
    ["NM", /\b(nm|near mint|nm-?m|nm-?mt|nm\/m|m\/nm|mint|pack fresh|fresh pull|freshly pulled|straight from pack|pulled and sleeved|psa ready)\b/],
  ];

  function findRaw(t) {
    const found = [];
    for (const [cond, re] of RAW_PATTERNS) {
      let s = t.replace(/\b(never played|unplayed|not played)\b/g, " pack fresh ");
      if (cond === "MP") s = s.replace(/\b(lightly|moderately|heavily|slightly) played\b/g, " ");
      if (cond === "NM") s = s.replace(/\bnear mint\b/g, " near_mint ").replace(/\bgem mint\b/g, " ");
      if (cond === "NM" && /\bnear_mint\b/.test(s)) { found.push(cond); continue; }
      if (re.test(s)) found.push(cond);
    }
    if (!found.length) return null;
    found.sort((a, b) => RAW_ORDER.indexOf(b) - RAW_ORDER.indexOf(a));
    return { type: "raw", condition: found[0], label: found[0] };
  }

  function fromDescriptors(listing) {
    const d = listing.descriptors || [];
    const get = (rx) => {
      const x = d.find((e) => rx.test(String(e.name || "").toLowerCase()));
      return x ? String((x.values || [])[0] || "").toLowerCase() : "";
    };
    const graderTxt = get(/grader/);
    const gradeTxt = get(/^grade$/);
    const cardCond = get(/card condition/);
    if (graderTxt && gradeTxt) {
      const g = graderFromText(norm(graderTxt)) ||
        (/professional sports authenticator/.test(graderTxt) ? "PSA" : /certified guaranty|cgc/.test(graderTxt) ? "CGC" : /beckett/.test(graderTxt) ? "BGS" : /sportscard guaranty/.test(graderTxt) ? "SGC" : null);
      const m = gradeTxt.match(/10|9\.5|[1-9](\.5)?/);
      if (g && m) return findGraded(norm(`${g} ${gradeTxt}`)) || { type: "graded", grader: g, grade: m[0], label: `${g} ${m[0]}` };
    }
    if (cardCond) {
      if (/near mint/.test(cardCond)) return { type: "raw", condition: "NM", label: "NM" };
      if (/lightly played|excellent/.test(cardCond)) return { type: "raw", condition: "LP", label: "LP" };
      if (/moderately played|very good/.test(cardCond)) return { type: "raw", condition: "MP", label: "MP" };
      if (/heavily played|poor/.test(cardCond)) return { type: "raw", condition: "HP", label: "HP" };
      if (/damaged/.test(cardCond)) return { type: "raw", condition: "DMG", label: "DMG" };
    }
    return null;
  }

  function readCondition(listing) {
    const title = norm(listing.title);
    const desc = norm(listing.description);
    const fromSpecs = fromDescriptors(listing);
    if (fromSpecs) return { ...fromSpecs, source: "item specifics" };
    const g = findGraded(title);
    if (g && !g.hedged) return { ...g, source: "title" };
    const ungraded = String(listing.conditionId) === "4000" || /ungraded/i.test(listing.condition || "");
    const raw = findRaw(title.replace(/\bgem mint\b/g, " "));
    if (raw) return { ...raw, source: "title" };
    if (desc) {
      if (!ungraded) {
        const gd = findGraded(desc);
        if (gd && !gd.hedged && String(listing.conditionId) === "2750") return { ...gd, source: "description" };
      }
      const rd = findRaw(desc);
      if (rd) return { ...rd, source: "description" };
    }
    if (String(listing.conditionId) === "2750") return { type: "graded", grader: null, grade: null, label: "Graded, grade unclear", unclear: true, source: "eBay condition" };
    return null;
  }

  function sameCard(listing, card) {
    const t = norm(listing.title);
    if (EXCLUDE.test(t)) return { ok: false, reason: "lot, proxy or accessory" };
    if (card) {
      const cardLang = card.language || "English";
      const listLang = listingLanguage(listing);
      if (listLang !== cardLang) return { ok: false, reason: `${listLang} card` };
      const num = String(card.number || "").toLowerCase().replace(/^0+(?=\d)/, "");
      if (num) {
        const numRe = new RegExp("(^|[^0-9a-z])0*" + num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\s?/|$|[^0-9])");
        if (!numRe.test(t)) return { ok: false, reason: "card number missing from title" };
      }
      const first = norm(card.name).split(/[\s-]/).find((w) => w.length > 2 && !["dark", "light", "team", "the"].includes(w));
      if (first && !t.includes(first)) return { ok: false, reason: "different card name" };
      const v = String(card.variant || "").toLowerCase();
      const is1st = /\b1st\b|first edition|1st edition|1st ed\b/.test(t);
      if (v.includes("1st")) { if (!is1st) return { ok: false, reason: "not 1st Edition" }; }
      else if (is1st) return { ok: false, reason: "1st Edition listing" };
      const isShadowless = /\bshadowless\b/.test(t);
      if (v.includes("shadowless") && !isShadowless) return { ok: false, reason: "not Shadowless" };
      if (!v.includes("shadowless") && isShadowless) return { ok: false, reason: "Shadowless listing" };
      const isRev = /\b(reverse|rev holo|reverse holo)\b/.test(t);
      if (v.includes("reverse") && !isRev) return { ok: false, reason: "not Reverse Holo" };
      if (!v.includes("reverse") && isRev) return { ok: false, reason: "Reverse Holo listing" };
    }
    return { ok: true };
  }

  function cardCondKey(card) {
    if (card.condType === "graded") return `${card.grader} ${card.grade}`.toUpperCase();
    return String(card.condition || "").toUpperCase();
  }
  function listingCondKey(c) {
    if (!c) return null;
    if (c.type === "graded") return c.grader && c.grade ? `${c.grader} ${c.grade}`.toUpperCase() : null;
    return c.condition;
  }

  function parseListing(listing, card) {
    const same = sameCard(listing, card);
    if (!same.ok) return { status: "excluded", cond: null, reason: same.reason };
    const cond = readCondition(listing);
    if (!cond || cond.unclear) return { status: "unknown", cond, reason: "condition not stated" };
    if (card && listingCondKey(cond) === cardCondKey(card)) return { status: "match", cond };
    return { status: "other", cond };
  }

  function median(nums) {
    const a = nums.filter((n) => isFinite(n)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function robustStats(nums) {
    const a = nums.filter((n) => isFinite(n) && n > 0).sort((x, y) => x - y);
    if (!a.length) return null;
    let kept = a;
    if (a.length >= 5) {
      const q1 = a[Math.floor((a.length - 1) * 0.25)], q3 = a[Math.floor((a.length - 1) * 0.75)];
      const iqr = q3 - q1;
      kept = a.filter((n) => n >= q1 - 1.5 * iqr && n <= q3 + 1.5 * iqr);
    }
    return { median: median(kept), low: kept[0], high: kept[kept.length - 1], n: kept.length, dropped: a.length - kept.length };
  }

  const api = { parseListing, readCondition, sameCard, robustStats, median, norm, RAW_ORDER, LANGS, detectScript, listingLanguage };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BinderConditions = api;
})(typeof self !== "undefined" ? self : this);
