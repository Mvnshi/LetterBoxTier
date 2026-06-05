// /api/letterboxd  ->  GET /api/letterboxd?user=<username>
// Scrapes the user's full Letterboxd /films/ list (every page), then attaches
// poster art from TMDB. The TMDB key lives in process.env, never touches the
// browser.
//
// Required env var:  TMDB_API_KEY   (set in Vercel project settings + local .env)
//
// Getting the list past Cloudflare:
//
//   Letterboxd's /films/ pages sit behind a Cloudflare "Just a moment" challenge
//   that blocks any non-browser / datacenter IP (so a plain server fetch from
//   Vercel always 403s). We handle it in three tiers, best first:
//
//     1. SCRAPER API (set SCRAPER_API_KEY) - routes the fetch through a
//        Cloudflare-bypassing scraper service with residential IPs + JS render.
//        This is the only thing that reliably pulls the FULL list of an
//        arbitrary public profile from a server. See README for setup.
//     2. DIRECT http/2 - works from a clean/residential IP (e.g. local `vercel
//        dev`), no key needed. On Vercel this is normally blocked; we still try
//        it when no scraper key is configured.
//     3. RSS fallback - the public /rss/ feed isn't challenged, but it's the
//        diary/review feed (often far fewer films than the watched list), so
//        it's a last resort to return *something* instead of an error.
//
//   The films grid is a React LazyPoster component carrying data-item-slug /
//   data-item-name (e.g. "Office Romance (2026)"); parseFilms() reads that.

import http2 from "node:http2";
import zlib from "node:zlib";

export const config = { maxDuration: 60 };

const TMDB_KEY = process.env.TMDB_API_KEY;
const PAGE_CAP = 60; // safety cap (~4300 films); raise if you need more

// scraper service config (optional but recommended for arbitrary profiles)
const SCRAPER_KEY = process.env.SCRAPER_API_KEY;
const SCRAPER_PROVIDER = (process.env.SCRAPER_PROVIDER || "scraperapi").toLowerCase();
// power users can point at any provider: a full URL with {url} where the
// (url-encoded) target goes, e.g. https://api.foo.com/?key=XXX&render=1&url={url}
const SCRAPER_TEMPLATE = process.env.SCRAPER_URL_TEMPLATE;

// A complete, modern Chrome fingerprint for the direct-h2 path.
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  "accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

export default async function handler(req, res) {
  const startedAt = Date.now();
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=86400");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const user = String(req.query.user || "").trim().replace(/[^A-Za-z0-9_]/g, "");
  if (!user) { res.status(400).json({ error: "missing ?user=" }); return; }
  if (!TMDB_KEY) {
    res.status(500).json({ error: "TMDB_API_KEY is not set on the server. Add it in your Vercel project settings." });
    return;
  }

  try {
    // leave headroom in the 60s budget: ~42s for the (slow, JS-rendered) page
    // scrape, then the rest for TMDB posters, then ~8s to serialize the response.
    const { films, source } = await scrapeFilms(user, startedAt + 42000);
    if (!films.length) {
      res.status(404).json({ error: "no films found - make sure the profile is public and the username is correct." });
      return;
    }
    const withPosters = await attachPosters(films, startedAt + 52000);
    const body = { user, count: withPosters.length, films: withPosters, source };
    if (source === "recent") {
      body.note = "couldn't pull the full watched list (letterboxd's anti-bot blocked the server " +
        "and no scraper key is configured), so these are the recent films from the public RSS feed. " +
        "set up SCRAPER_API_KEY to import full profiles - see the README.";
    }
    res.status(200).json(body);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : "scrape failed" });
  }
}

/* ---------------- scrape orchestration ---------------- */

async function scrapeFilms(user, pagesDeadline) {
  // primary: full library via the paginated /films/ grid (scraper or direct)
  try {
    const films = await scrapeFilmsViaPages(user, pagesDeadline);
    if (films.length) return { films, source: "library" };
  } catch (_) {
    // blocked / scraper error / network hiccup -> fall through to RSS
  }
  // fallback: recent films via the public RSS feed (not behind the bot challenge)
  const films = await scrapeFilmsViaRss(user);
  return { films, source: "recent" };
}

// Shared page-collection logic; `getPage(p)` returns the HTML for films page p.
async function collectFilms(getPage, concurrency, deadline) {
  const first = await getPage(1);

  let maxPage = 1;
  const nums = [...first.matchAll(/\/films\/page\/(\d+)\//g)].map((m) => +m[1]);
  if (nums.length) maxPage = Math.min(Math.max(...nums), PAGE_CAP);

  const buckets = [parseFilms(first)];
  const rest = [];
  for (let p = 2; p <= maxPage; p++) rest.push(p);

  await pool(rest, concurrency, async (p) => {
    if (deadline && Date.now() > deadline) return; // big library + slow scraper: return partial
    try { buckets.push(parseFilms(await getPage(p))); }
    catch (_) { /* skip a flaky page rather than failing the whole request */ }
  });

  // flatten + dedupe by slug
  const map = new Map();
  for (const arr of buckets) for (const f of arr) if (!map.has(f.slug)) map.set(f.slug, f);
  return [...map.values()];
}

function scrapeFilmsViaPages(user, deadline) {
  return SCRAPER_KEY || SCRAPER_TEMPLATE
    ? scrapeViaScraper(user, deadline)
    : scrapeViaDirectH2(user, deadline);
}

/* ---------------- tier 1: scraper API ---------------- */

function scraperUrl(target) {
  const enc = encodeURIComponent(target);
  if (SCRAPER_TEMPLATE) return SCRAPER_TEMPLATE.replace("{url}", enc);
  const k = encodeURIComponent(SCRAPER_KEY || "");
  switch (SCRAPER_PROVIDER) {
    case "scrapingbee":
      return `https://app.scrapingbee.com/api/v1/?api_key=${k}&url=${enc}&render_js=true&stealth_proxy=true&country_code=us`;
    case "zenrows":
      return `https://api.zenrows.com/v1/?apikey=${k}&url=${enc}&js_render=true&antibot=true`;
    case "scrapingant":
      return `https://api.scrapingant.com/v2/general?url=${enc}&x-api-key=${k}&browser=true`;
    case "scraperapi":
    default:
      return `https://api.scraperapi.com/?api_key=${k}&url=${enc}&render=true&country_code=us`;
  }
}

async function scrapeViaScraper(user, deadline) {
  const getPage = async (p) => {
    const r = await fetch(scraperUrl(`https://letterboxd.com/${user}/films/page/${p}/`), {
      signal: AbortSignal.timeout(35000),
    });
    const body = await r.text();
    if (r.status !== 200) throw new Error("scraper responded " + r.status);
    if (/just a moment|enable javascript/i.test(body)) throw new Error("scraper returned a challenge page");
    return body;
  };
  // scraper calls are slow + credit-metered, so keep concurrency low
  return collectFilms(getPage, 3, deadline);
}

/* ---------------- tier 2: direct http/2 ---------------- */

async function scrapeViaDirectH2(user, deadline) {
  const client = await connectH2("https://letterboxd.com");
  client.on("error", () => {}); // don't let a late socket error crash the function
  try {
    return await collectFilms((p) => fetchPage(client, `/${user}/films/page/${p}/`), 6, deadline);
  } finally {
    client.close();
  }
}

function connectH2(origin) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin);
    const onError = (e) => { cleanup(); reject(e); };
    const onConnect = () => { cleanup(); resolve(client); };
    function cleanup() {
      client.removeListener("error", onError);
      client.removeListener("connect", onConnect);
    }
    client.once("error", onError);
    client.once("connect", onConnect);
  });
}

// Single GET over an existing h2 session, body already decompressed.
function h2Get(client, path) {
  return new Promise((resolve, reject) => {
    const req = client.request({ ":method": "GET", ":path": path, ":scheme": "https", ...BROWSER_HEADERS });
    let status = 0, enc = "";
    const chunks = [];
    req.on("response", (h) => { status = h[":status"]; enc = h["content-encoding"] || ""; });
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      let buf = Buffer.concat(chunks);
      try {
        if (enc === "br") buf = zlib.brotliDecompressSync(buf);
        else if (enc === "gzip") buf = zlib.gunzipSync(buf);
        else if (enc === "deflate") buf = zlib.inflateSync(buf);
      } catch (e) { reject(e); return; }
      resolve({ status, body: buf.toString("utf8") });
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.close(http2.constants.NGHTTP2_CANCEL); reject(new Error("request timed out")); });
    req.end();
  });
}

async function fetchPage(client, path) {
  let last = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((s) => setTimeout(s, 350 * attempt));
    const r = await h2Get(client, path);
    last = r.status;
    if (r.status === 200) return r.body;
    if (r.status !== 403) break; // only the bot challenge is worth retrying
  }
  throw new Error("letterboxd responded " + last);
}

/* ---------------- film grid parser ---------------- */

function parseFilms(html) {
  // Each film is a LazyPoster react-component carrying data-item-slug +
  // data-item-name. The name sits just *before* the slug in the same tag, so we
  // anchor on each slug and read a window that reaches back to catch the name.
  const out = [];
  const slugRe = /data-item-slug="([^"]+)"/g;
  const hits = [];
  let m;
  while ((m = slugRe.exec(html))) hits.push({ slug: m[1], at: m.index });

  for (let i = 0; i < hits.length; i++) {
    const { slug, at } = hits[i];
    const from = Math.max(0, at - 400);
    const to = i + 1 < hits.length ? hits[i + 1].at : at + 200;
    const win = html.slice(from, to);

    let title = "", year = "";
    const nm = win.match(/data-item-name="([^"]*)"/) ||
               win.match(/data-item-full-display-name="([^"]*)"/);
    if (nm) {
      let name = decodeEntities(nm[1]);
      const ym = name.match(/\s*\((\d{4})\)\s*$/); // trailing "(YYYY)"
      if (ym) { year = ym[1]; name = name.slice(0, ym.index).trim(); }
      title = name;
    }
    if (!year) { const ys = slug.match(/-(\d{4})$/); if (ys) year = ys[1]; }
    if (!title) title = slugToTitle(slug);

    out.push({ slug, title, year });
  }
  return out;
}

/* ---------------- tier 3: recent films (RSS fallback) ---------------- */

async function scrapeFilmsViaRss(user) {
  let r;
  try {
    r = await fetch(`https://letterboxd.com/${user}/rss/`, {
      headers: { "user-agent": BROWSER_HEADERS["user-agent"], "accept": "application/rss+xml,application/xml,*/*" },
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) { return []; }
  if (!r.ok) return [];
  const xml = await r.text();

  const map = new Map();
  for (const block of xml.split("<item>").slice(1)) {
    const slugM = block.match(/\/film\/([^/<\s]+)\//);
    const slug = slugM ? slugM[1] : "";
    if (!slug || map.has(slug)) continue; // dedupe rewatches

    let title = decodeEntities(stripCdata(tagText(block, "letterboxd:filmTitle")));
    const year = stripCdata(tagText(block, "letterboxd:filmYear")).trim();
    const tmdbId = stripCdata(tagText(block, "tmdb:movieId")).trim();

    if (!title) {
      const raw = decodeEntities(stripCdata(tagText(block, "title")));
      title = raw.replace(/\s*-\s*★.*$/, "").replace(/,\s*\d{4}\s*$/, "").trim();
    }
    if (!title) title = slugToTitle(slug);

    map.set(slug, { slug, title, year, tmdbId: tmdbId || "" });
  }
  return [...map.values()];
}

function tagText(block, tag) {
  const m = block.match(new RegExp("<" + tag.replace(/:/g, "\\:") + ">([\\s\\S]*?)</" + tag.replace(/:/g, "\\:") + ">"));
  return m ? m[1] : "";
}
function stripCdata(s) {
  return (s || "").replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "").trim();
}

/* ---------------- shared helpers ---------------- */

function slugToTitle(slug) {
  return slug.replace(/-\d{4}$/, "").replace(/-/g, " ").trim();
}

function decodeEntities(s) {
  s = s || "";
  for (let i = 0; i < 2; i++) {
    s = s
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return s.trim();
}

/* ---------------- tmdb posters ---------------- */

async function attachPosters(films, deadline) {
  const cache = new Map();
  await pool(films, 30, async (f) => {
    if (deadline && Date.now() > deadline) return; // near the budget: rest render as placeholders
    if (f.tmdbId) { f.poster = await tmdbPosterById(f.tmdbId); return; }
    const key = (f.title + "|" + f.year).toLowerCase();
    if (cache.has(key)) { f.poster = cache.get(key); return; }
    const poster = await tmdbPoster(f.title, f.year);
    cache.set(key, poster);
    f.poster = poster;
  });
  return films;
}

async function tmdbPoster(title, year) {
  try {
    const u = new URL("https://api.themoviedb.org/3/search/movie");
    u.searchParams.set("api_key", TMDB_KEY);
    u.searchParams.set("query", title);
    u.searchParams.set("include_adult", "false");
    if (year) u.searchParams.set("primary_release_year", year);
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return "";
    const j = await r.json();
    const hit = (j.results || []).find((x) => x.poster_path);
    return hit ? "https://image.tmdb.org/t/p/w342" + hit.poster_path : "";
  } catch (_) {
    return "";
  }
}

async function tmdbPosterById(id) {
  try {
    const u = new URL("https://api.themoviedb.org/3/movie/" + encodeURIComponent(id));
    u.searchParams.set("api_key", TMDB_KEY);
    const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return "";
    const j = await r.json();
    return j.poster_path ? "https://image.tmdb.org/t/p/w342" + j.poster_path : "";
  } catch (_) {
    return "";
  }
}

/* ---------------- tiny concurrency pool ---------------- */

async function pool(items, size, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
