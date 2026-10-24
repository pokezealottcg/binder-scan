/* Binder Scan — Pokémon names in Japanese, Korean and Chinese, mapped to English.

   The list is fetched once from a free source and kept on the phone for 30 days.
   Two sources are tried in order; Settings → "Test card-name data" reports which one answered. */
(function (root) {
  "use strict";

  const STORE_KEY = "bs.names.v1";
  const MAX_AGE = 30 * 864e5;
  const LANG_OF = { 1: "Japanese", 11: "Japanese", 3: "Korean", 4: "Chinese", 12: "Chinese" };

  const SOURCES = [
    {
      name: "jsDelivr (pokemon package)",
      async load() {
        const langs = { ja: "Japanese", ko: "Korean", "zh-Hant": "Chinese", "zh-Hans": "Chinese" };
        const en = await getJson("https://cdn.jsdelivr.net/npm/pokemon@2.2.1/data/en.json");
        const enList = asList(en);
        if (!enList.length) throw new Error("no English list");
        const map = {};
        for (const [code, label] of Object.entries(langs)) {
          let list;
          try { list = asList(await getJson(`https://cdn.jsdelivr.net/npm/pokemon@2.2.1/data/${code}.json`)); } catch { continue; }
          list.forEach((foreign, i) => {
            const english = enList[i];
            if (foreign && english) map[key(foreign)] = { en: english, lang: label };
          });
        }
        if (Object.keys(map).length < 200) throw new Error("too few names");
        return map;
      },
    },
    {
      name: "PokéAPI",
      async load() {
        const q = "{pokemon_v2_pokemonspeciesname(where:{language_id:{_in:[1,3,4,9,11,12]}}){name language_id pokemon_species_id}}";
        const r = await fetch("https://beta.pokeapi.co/graphql/v1beta", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
        });
        if (!r.ok) throw new Error("PokéAPI replied " + r.status);
        const rows = (await r.json())?.data?.pokemon_v2_pokemonspeciesname || [];
        if (!rows.length) throw new Error("no rows");
        const english = {};
        for (const row of rows) if (row.language_id === 9) english[row.pokemon_species_id] = row.name;
        const map = {};
        for (const row of rows) {
          const lang = LANG_OF[row.language_id];
          const en = english[row.pokemon_species_id];
          if (lang && en && row.name) map[key(row.name)] = { en, lang };
        }
        if (Object.keys(map).length < 200) throw new Error("too few names");
        return map;
      },
    },
  ];

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(url + " replied " + r.status);
    return r.json();
  }
  function asList(data) {
    if (Array.isArray(data)) return data.map((v) => (typeof v === "string" ? v : v?.name || ""));
    if (data && typeof data === "object") {
      const keys = Object.keys(data).filter((k) => /^\d+$/.test(k)).sort((a, b) => a - b);
      if (keys.length) return keys.map((k) => String(data[k]));
    }
    return [];
  }
  /* Kana, spacing and the "ー" mark vary between prints, so compare loosely. */
  function key(s) {
    return String(s || "")
      .normalize("NFKC")
      .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60)) // katakana -> hiragana
      .replace(/[\s・·.,'’\-ー—–]/g, "")
      .toLowerCase();
  }

  let cache = null;
  function readStored() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || !j.map || Date.now() - j.at > MAX_AGE) return null;
      return j;
    } catch { return null; }
  }
  function store(map, source) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), source, map })); } catch {}
  }

  let loading = null;
  function load(force) {
    if (!force) {
      if (cache) return Promise.resolve(cache);
      const stored = readStored();
      if (stored) { cache = stored; return Promise.resolve(cache); }
    }
    if (loading) return loading;
    loading = (async () => {
      const tried = [];
      for (const s of SOURCES) {
        try {
          const map = await s.load();
          cache = { at: Date.now(), source: s.name, map, count: Object.keys(map).length };
          store(map, s.name);
          loading = null;
          return cache;
        } catch (e) { tried.push(`${s.name}: ${e.message}`); }
      }
      loading = null;
      const e = new Error("Couldn't load the card-name list. " + tried.join(" · "));
      e.tried = tried;
      throw e;
    })();
    return loading;
  }

  /* Find the English name inside a line of scanned Japanese/Korean/Chinese text. */
  function lookup(text, loaded) {
    const map = (loaded || cache)?.map;
    if (!map) return null;
    const whole = key(text);
    if (map[whole]) return map[whole];
    const chunks = String(text).split(/[\s　]+/).filter(Boolean);
    for (const c of chunks) { const k = key(c); if (k.length > 1 && map[k]) return map[k]; }
    // Card names add suffixes (ex, V, VMAX, GX) and symbols around the name.
    for (const c of chunks) {
      const k = key(c);
      for (let len = k.length; len >= 2; len--) {
        const head = k.slice(0, len);
        if (map[head]) return map[head];
      }
    }
    return null;
  }

  const api = { load, lookup, key, get cached() { return cache; }, sources: SOURCES.map((s) => s.name) };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BinderNames = api;
})(typeof self !== "undefined" ? self : this);
