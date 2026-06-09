/**
 * Abby's Degree Map — Cloudflare Worker
 *
 * Serves the static app, persists the plan in KV, AND harvests the live SDSU
 * catalog into KV so the app can show every course's name (and, on demand, its
 * description) — refreshed from a button in the app itself. No local scripts.
 *
 * Dashboard setup (Workers → your Worker → Settings):
 *   - Assets binding:  ASSETS   (upload index.html + data.js)
 *   - KV binding:      STUDY_PLANS   (one namespace stores everything, by prefix)
 *   - Variable/secret: REFRESH_TOKEN   (any password; required to run a refresh)
 *   - (optional) Variables: CATALOG_CATOID (default 12 = 2026-27),
 *                           CATALOG_NAVOID (default 1121),
 *                           CATALOG_GE_POID (default 11884)
 *
 * KV keys:  plan:<id>            the saved plan
 *           catalog:index        { code: {coid,title,units,desc,reqs,overlays} }
 *           catalog:meta         { count, lastRefresh, catoid }
 *           course:<coid>        cached per-course {units,desc,prereq}
 *
 * API:
 *   GET  /api/state/:id            GET  /api/catalog            (full index)
 *   PUT  /api/state/:id            GET  /api/catalog/meta       (count/date)
 *   GET  /api/course/:coid         (lazy detail; caches in KV)
 *   POST /api/refresh?...          (auth via X-Refresh-Token; one batch)
 */

const CAT = "https://catalog.sdsu.edu";
const UA = { "User-Agent": "abby-degree-planner/1.0 (personal academic planning)" };
const CATALOG_KEY = "catalog:index";
const META_KEY = "catalog:meta";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,PUT,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Refresh-Token",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // ---------- plan state ----------
    let m = path.match(/^\/api\/state\/([A-Za-z0-9_-]{1,64})$/);
    if (m) {
      if (!env.STUDY_PLANS) return json({ error: "KV STUDY_PLANS not bound" }, 500, cors);
      const key = "plan:" + m[1];
      if (request.method === "GET") {
        const v = await env.STUDY_PLANS.get(key);
        return v ? new Response(v, { headers: { "Content-Type": "application/json", ...cors } })
                 : new Response("null", { status: 404, headers: { "Content-Type": "application/json", ...cors } });
      }
      if (request.method === "PUT") {
        const body = await request.text();
        try { JSON.parse(body); } catch { return json({ error: "invalid JSON" }, 400, cors); }
        if (body.length > 256 * 1024) return json({ error: "too large" }, 413, cors);
        await env.STUDY_PLANS.put(key, body);
        return json({ ok: true }, 200, cors);
      }
    }

    // ---------- catalog index ----------
    if (path === "/api/catalog") {
      const v = (await env.STUDY_PLANS?.get(CATALOG_KEY)) || "{}";
      return new Response(v, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=300", ...cors } });
    }
    if (path === "/api/catalog/meta") {
      const v = (await env.STUDY_PLANS?.get(META_KEY)) || "{}";
      return new Response(v, { headers: { "Content-Type": "application/json", ...cors } });
    }

    // ---------- lazy per-course detail ----------
    m = path.match(/^\/api\/course\/(\d{1,9})$/);
    if (m) {
      const coid = m[1], ckey = "course:" + coid;
      const cached = await env.STUDY_PLANS?.get(ckey);
      if (cached) return new Response(cached, { headers: { "Content-Type": "application/json", "Cache-Control": "max-age=86400", ...cors } });
      const catoid = url.searchParams.get("catoid") || env.CATALOG_CATOID || "12";
      const detail = await fetchCourseDetail(catoid, coid);
      const body = JSON.stringify(detail);
      if (detail.units != null || detail.desc) await env.STUDY_PLANS?.put(ckey, body);
      return new Response(body, { headers: { "Content-Type": "application/json", ...cors } });
    }

    // ---------- catalog refresh (one resumable batch) ----------
    if (path === "/api/refresh" && request.method === "POST") {
      if (!env.STUDY_PLANS) return json({ error: "KV STUDY_PLANS not bound" }, 500, cors);
      if (!env.REFRESH_TOKEN || request.headers.get("X-Refresh-Token") !== env.REFRESH_TOKEN)
        return json({ error: "unauthorized — set REFRESH_TOKEN and provide it" }, 401, cors);
      const catoid = url.searchParams.get("catoid") || env.CATALOG_CATOID || "12";
      const navoid = url.searchParams.get("navoid") || env.CATALOG_NAVOID || "1121";
      const gepoid = url.searchParams.get("gepoid") || env.CATALOG_GE_POID || "11884";
      const start = parseInt(url.searchParams.get("start") || "1", 10);
      const pages = Math.min(parseInt(url.searchParams.get("pages") || "15", 10), 25);
      try {
        const result = await refreshBatch(env, { catoid, navoid, gepoid, start, pages });
        return json(result, 200, cors);
      } catch (e) {
        return json({ error: String((e && e.message) || e) }, 500, cors);
      }
    }

    // ---------- static assets ----------
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
    }
    return new Response("ASSETS binding not configured", { status: 500 });
  },
};

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...(extra || {}) } });
}

/* ---------------- catalog harvesting (runs on Cloudflare's edge) ---------------- */

// One refresh batch: fetch `pages` listing pages, parse code+title+coid, merge into
// KV. On the first batch also harvest GE-area tags from the GE Requirements page.
async function refreshBatch(env, { catoid, navoid, gepoid, start, pages }) {
  const index = JSON.parse((await env.STUDY_PLANS.get(CATALOG_KEY)) || "{}");
  let added = 0, lastPageEmpty = false, page = start;

  for (let i = 0; i < pages; i++, page++) {
    const list = await fetchListingPage(catoid, navoid, page);
    if (list.length === 0) { lastPageEmpty = true; break; }
    for (const c of list) {
      const cur = index[c.code] || {};
      index[c.code] = {
        coid: c.coid, title: c.title || cur.title || c.code,
        units: cur.units ?? null, desc: cur.desc ?? null,
        reqs: cur.reqs || [], overlays: cur.overlays || [],
      };
      added++;
    }
  }

  if (start === 1) {
    try {
      const ge = await fetchGeTags(catoid, gepoid);
      for (const [code, t] of Object.entries(ge)) {
        const cur = index[code] || { coid: null, title: code, units: null, desc: null, reqs: [], overlays: [] };
        cur.reqs = Array.from(new Set([...(cur.reqs || []), ...t.reqs]));
        cur.overlays = Array.from(new Set([...(cur.overlays || []), ...t.overlays]));
        index[code] = cur;
      }
    } catch (e) { /* GE tagging is best-effort */ }
  }

  await env.STUDY_PLANS.put(CATALOG_KEY, JSON.stringify(index));
  const count = Object.keys(index).length;
  const done = lastPageEmpty;
  if (done) await env.STUDY_PLANS.put(META_KEY, JSON.stringify({ count, lastRefresh: new Date().toISOString(), catoid }));
  return { added, total: count, nextStart: done ? null : page, done, processedThrough: page - 1 };
}

async function fetchListingPage(catoid, navoid, page) {
  const url = `${CAT}/content.php?catoid=${catoid}&navoid=${navoid}&filter%5Bcpage%5D=${page}#acalog_template_course_filter`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return [];
  const links = [];
  const rw = new HTMLRewriter().on('a[href*="preview_course"]', {
    element(el) { links.push({ href: el.getAttribute("href") || "", text: "" }); },
    text(t) { if (links.length) links[links.length - 1].text += t.text; },
  });
  await rw.transform(res).arrayBuffer();
  const out = [];
  for (const l of links) {
    const cm = l.href.match(/coid=(\d+)/);
    const tm = l.text.replace(/\s+/g, " ").trim().match(/^([A-Z]{2,6}\s?[A-Z]?\s*\d{2,3}[A-Z]?)\s*[-–]\s*(.+)$/);
    if (cm && tm) out.push({ coid: cm[1], code: tm[1].replace(/\s+/g, " ").replace("POL S", "POLS").trim(), title: tm[2].trim() });
  }
  return out;
}

// GE Requirements page: tag courses by area, tracking the nearest preceding heading.
const GE_MAP = [
  ["oral communication", "oral", null], ["written communication", "written", null],
  ["composition", "written", null], ["critical thinking", "critical", null],
  ["physical science", "physci", null], ["life science", "lifesci", null],
  ["laboratory", "lab", null], ["mathematics", null, "math_ge"], ["quantitative", null, "math_ge"],
  ["social and behavioral", "socbeh", null], ["social & behavioral", "socbeh", null],
  ["fine arts", "arts", null], ["arts", "arts", null], ["humanities", "humanities", null],
  ["american institutions", null, "aminst"], ["american history", null, "aminst"],
  ["united states constitution", null, "aminst"], ["california", null, "aminst"],
  ["ethnic studies", null, "ethnic"], ["cultural diversity", null, "cdiv"],
];
function classifyHeading(text) {
  const t = text.toLowerCase();
  if (t.includes("explorations")) {
    if (t.includes("natural")) return ["expl_nat", null];
    if (t.includes("social")) return ["expl_soc", null];
    if (t.includes("human")) return ["expl_hum", null];
  }
  for (const [kw, req, ovl] of GE_MAP) if (t.includes(kw)) return [req, ovl];
  return [null, null];
}
async function fetchGeTags(catoid, gepoid) {
  const res = await fetch(`${CAT}/preview_program.php?catoid=${catoid}&poid=${gepoid}`, { headers: UA });
  if (!res.ok) return {};
  const tags = {};
  let curReq = null, curOvl = null;
  const links = [];
  const rw = new HTMLRewriter()
    .on("h1,h2,h3,h4,strong,b", { text(t) { const x = t.text.trim(); if (x && x.length < 120) { const [r, o] = classifyHeading(x); if (r || o) { curReq = r; curOvl = o; } } } })
    .on('a[href*="preview_course"]', {
      element(el) { links.push({ href: el.getAttribute("href") || "", text: "", req: curReq, ovl: curOvl }); },
      text(t) { if (links.length) links[links.length - 1].text += t.text; },
    });
  await rw.transform(res).arrayBuffer();
  for (const l of links) {
    const tm = l.text.replace(/\s+/g, " ").trim().match(/^([A-Z]{2,6}\s?[A-Z]?\s*\d{2,3}[A-Z]?)\s*[-–]/);
    if (!tm) continue;
    const code = tm[1].replace(/\s+/g, " ").replace("POL S", "POLS").trim();
    const e = tags[code] || { reqs: [], overlays: [] };
    if (l.req && !e.reqs.includes(l.req)) e.reqs.push(l.req);
    if (l.ovl && !e.overlays.includes(l.ovl)) e.overlays.push(l.ovl);
    tags[code] = e;
  }
  return tags;
}

async function fetchCourseDetail(catoid, coid) {
  const res = await fetch(`${CAT}/preview_course_nopop.php?catoid=${catoid}&coid=${coid}`, { headers: UA });
  if (!res.ok) return { units: null, desc: null, prereq: null };
  const html = await res.text();
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  let units = null;
  const um = text.match(/Units?:\s*([\d.]+)/);
  if (um) units = parseFloat(um[1]);
  let prereq = null;
  const pm = text.match(/Prerequisite[s]?:\s*(.+?)(?:\.\s|$)/);
  if (pm) prereq = pm[1].trim().slice(0, 200);
  let desc = null;
  const dm = text.split(/Units?:\s*[\d.]+\s*/);
  if (dm.length > 1) desc = (dm[1].replace(/Prerequisite[s]?:.*/i, "").trim().slice(0, 600)) || null;
  return { units, desc, prereq };
}
