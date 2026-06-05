// /api/letterboxd  ->  GET /api/letterboxd?user=<username>
// Scrapes the user's full Letterboxd /films/ list (every page) server-side,
// then attaches poster art from TMDB. The TMDB key lives in process.env, never
// touches the browser.
//
// Required env var:  TMDB_API_KEY   (set in Vercel project settings + local .env)

export const config = { maxDuration: 60 };

const TMDB_KEY = process.env.TMDB_API_KEY;
const PAGE_CAP = 60; // safety cap (~4300 films); raise if you need more
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export default async function handler(req, res) {
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
    const films = await scrapeFilms(user);
    if (!films.length) {
      res.status(404).json({ error: "no films found - make sure the profile is public and the username is correct." });
      return;
    }
    const withPosters = await attachPosters(films);
    res.status(200).json({ user, count: withPosters.length, films: withPosters });
  } catch (e) {
    res.status(500).json({ error: e && e.message ? e.message : "scrape failed" });
  }
}

/* ---------------- letterboxd scrape ---------------- */

async function fetchHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*", "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error("letterboxd responded " + r.status);
  return r.text();
}

async function scrapeFilms(user) {
  const base = `https://letterboxd.com/${user}/films/`;
  const first = await fetchHtml(base + "page/1/");

  // figure out how many pages exist from the pagination links
  let maxPage = 1;
  const nums = [...first.matchAll(/\/films\/page\/(\d+)\//g)].map((m) => +m[1]);
  if (nums.length) maxPage = Math.min(Math.max(...nums), PAGE_CAP);

  const buckets = [parseFilms(first)];
  const rest = [];
  for (let p = 2; p <= maxPage; p++) rest.push(p);

  await pool(rest, 8, async (p) => {
    try { buckets.push(parseFilms(await fetchHtml(base + "page/" + p + "/"))); }
    catch (_) { /* skip a flaky page rather than failing the whole request */ }
  });

  // flatten + dedupe by slug
  const map = new Map();
  for (const arr of buckets) for (const f of arr) if (!map.has(f.slug)) map.set(f.slug, f);
  return [...map.values()];
}

function parseFilms(html) {
  const out = [];
  const parts = html.split('data-film-slug="');
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const end = chunk.indexOf('"');
    if (end < 1) continue;
    const slug = chunk.slice(0, end);
    const head = chunk.slice(0, 700); // look ahead far enough to catch the <img alt="...">

    let title = "";
    const alt = head.match(/alt="([^"]*)"/);
    if (alt) title = alt[1];
    if (!title) {
      const nm = head.match(/data-film-name="([^"]*)"/);
      if (nm) title = nm[1];
    }
    if (!title) title = slugToTitle(slug);

    const yr = head.match(/data-film-release-year="(\d{4})"/);
    const year = yr ? yr[1] : "";

    out.push({ slug, title: decodeEntities(title), year });
  }
  return out;
}

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

async function attachPosters(films) {
  const cache = new Map();
  await pool(films, 25, async (f) => {
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

/* ---------------- tiny concurrency pool ---------------- */

async function pool(items, size, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}
