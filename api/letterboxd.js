// /api/letterboxd  ->  GET /api/letterboxd?user=<username>
// Scrapes the user's full Letterboxd /films/ list (every page) server-side,
// then attaches poster art from TMDB. The TMDB key lives in process.env, never
// touches the browser.
//
// Required env var:  TMDB_API_KEY   (set in Vercel project settings + local .env)
//
// Two things broke the old scraper, both fixed here:
//
//  1. Letterboxd sits behind Cloudflare, which now 403s ("Just a moment") any
//     HTTP/1.1 request claiming to be Chrome - real browsers always speak h2.
//     Node's global fetch() is HTTP/1.1, so it got blocked. We use the built-in
//     node:http2 client with a full browser header set instead.
//
//  2. The films grid markup changed: the old data-film-slug attribute is gone,
//     replaced by a React LazyPoster component carrying data-item-slug /
//     data-item-name. parseFilms() reads the new shape.
//
// If Cloudflare still blocks the page scrape (e.g. a datacenter IP with a bad
// reputation), we fall back to the public RSS feed, which isn't behind the bot
// challenge - that returns the most recent ~50 logged films instead of the full
// library, so the user always gets something rather than a hard error.

import http2 from "node:http2";
import zlib from "node:zlib";

export const config = { maxDuration: 60 };

const TMDB_KEY = process.env.TMDB_API_KEY;
const PAGE_CAP = 60; // safety cap (~4300 films); raise if you need more

// A complete, modern Chrome fingerprint. The combination of a current UA plus the
// sec-ch-ua / sec-fetch / upgrade-insecure-requests hints is what Cloudflare looks
// for; a bare UA alone still gets challenged.
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

  // temporary diagnostics: GET /api/letterboxd?user=X&debug=1
  if (req.query.debug) { res.status(200).json(await debugScrape(user)); return; }

  if (!TMDB_KEY) {
    res.status(500).json({ error: "TMDB_API_KEY is not set on the server. Add it in your Vercel project settings." });
    return;
  }

  try {
    const { films, source } = await scrapeFilms(user);
    if (!films.length) {
      res.status(404).json({ error: "no films found - make sure the profile is public and the username is correct." });
      return;
    }
    // leave ~12s of the 60s budget for the response so huge libraries (1000+
    // films) never time out mid-poster-fetch - any stragglers fall back to the
    // labelled placeholder the frontend already renders.
    const withPosters = await attachPosters(films, startedAt + 48000);
    const body = { user, count: withPosters.length, films: withPosters, source };
    if (source === "recent") {
      body.note = "letterboxd is rate-limiting the full-library scrape right now, " +
        "so these are your most recent logged films. try again in a bit for the whole history.";
    }
    res.status(200).json(body);
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : "scrape failed" });
  }
}

/* ---------------- scrape orchestration ---------------- */

async function scrapeFilms(user) {
  // primary: full library via the paginated /films/ grid
  try {
    const films = await scrapeFilmsViaPages(user);
    if (films.length) return { films, source: "library" };
  } catch (_) {
    // blocked / network hiccup -> fall through to RSS
  }
  // fallback: recent films via the public RSS feed (not behind the bot challenge)
  const films = await scrapeFilmsViaRss(user);
  return { films, source: "recent" };
}

/* ---------------- diagnostics ---------------- */

async function debugScrape(user) {
  const out = { user, region: process.env.VERCEL_REGION || null };
  try {
    const client = await connectH2("https://letterboxd.com");
    client.on("error", () => {});
    try {
      const r = await h2Get(client, `/${user}/films/page/1/`);
      out.pageStatus = r.status;
      out.bodyLen = r.body.length;
      out.challenge = /just a moment|enable javascript/i.test(r.body);
      out.filmsOnPage = (r.body.match(/data-item-slug=/g) || []).length;
      out.snippet = r.body.slice(0, 160);
    } finally { client.close(); }
  } catch (e) { out.pageError = e && e.message; }
  try {
    const rr = await fetch(`https://letterboxd.com/${user}/rss/`, { headers: { "user-agent": BROWSER_HEADERS["user-agent"] } });
    out.rssStatus = rr.status;
  } catch (e) { out.rssError = e && e.message; }
  return out;
}

/* ---------------- http/2 client ---------------- */

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

// Single GET over an existing h2 session. Returns { status, body } with the body
// already decompressed (Cloudflare always sends gzip/br).
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

// Fetch one page as HTML. Cloudflare occasionally throws a one-off challenge even
// over h2, so retry a couple of times with a short backoff before giving up.
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

/* ---------------- letterboxd: full library (pages) ---------------- */

async function scrapeFilmsViaPages(user) {
  const client = await connectH2("https://letterboxd.com");
  client.on("error", () => {}); // don't let a late socket error crash the function
  try {
    const path = (p) => `/${user}/films/page/${p}/`;
    const first = await fetchPage(client, path(1));

    // figure out how many pages exist from the pagination links
    let maxPage = 1;
    const nums = [...first.matchAll(/\/films\/page\/(\d+)\//g)].map((m) => +m[1]);
    if (nums.length) maxPage = Math.min(Math.max(...nums), PAGE_CAP);

    const buckets = [parseFilms(first)];
    const rest = [];
    for (let p = 2; p <= maxPage; p++) rest.push(p);

    // h2 multiplexes streams over the one connection, so we can pull pages in parallel
    await pool(rest, 6, async (p) => {
      try { buckets.push(parseFilms(await fetchPage(client, path(p)))); }
      catch (_) { /* skip a flaky page rather than failing the whole request */ }
    });

    // flatten + dedupe by slug
    const map = new Map();
    for (const arr of buckets) for (const f of arr) if (!map.has(f.slug)) map.set(f.slug, f);
    return [...map.values()];
  } finally {
    client.close();
  }
}

function parseFilms(html) {
  // Letterboxd renders each film as a LazyPoster react-component carrying
  // data-item-slug + data-item-name (e.g. "Office Romance (2026)"). The name sits
  // just *before* the slug in the same tag, so we anchor on each slug and read a
  // window that reaches back far enough to catch the name.
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

/* ---------------- letterboxd: recent films (RSS fallback) ---------------- */

async function scrapeFilmsViaRss(user) {
  let r;
  try {
    r = await fetch(`https://letterboxd.com/${user}/rss/`, {
      headers: { "user-agent": BROWSER_HEADERS["user-agent"], "accept": "application/rss+xml,application/xml,*/*" },
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
      // fall back to "<title>Name, YEAR - ★★★</title>"
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
  // strip a trailing disambiguation year (e.g. "heat-1995")
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
    // once we're near the time budget, stop fetching; the rest render as placeholders.
    if (deadline && Date.now() > deadline) return;
    // RSS gives us an exact TMDB id - use it for a precise poster, no fuzzy search.
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
    const r = await fetch(u);
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
    const r = await fetch(u);
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
