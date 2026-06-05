# movie tier list

drag-and-drop tier list for movies. paste a letterboxd profile, it imports
your films with poster art, you drag them into S-F tiers and export a png.

```
.
├── index.html        the whole app (frontend, no build step)
├── api/
│   └── letterboxd.js  serverless function: scrapes your library + TMDB posters
└── package.json
```

## how the import works

letterboxd's `/films/` pages sit behind a Cloudflare "Just a moment" challenge
that blocks any non-browser / datacenter IP. so a plain server fetch from vercel
gets a 403. the backend handles this in three tiers, best first:

1. **scraper API (recommended, set `SCRAPER_API_KEY`):** routes the fetch through
   a Cloudflare-bypassing scraper service (residential IPs + JS render). this is
   the only thing that reliably pulls the **full** list of an *arbitrary* public
   profile from the deployed server. setup in step 2 below.
2. **direct http/2 (no key):** works from a clean / residential IP, e.g. local
   `vercel dev`. on vercel this is normally blocked, so it's mostly for local use.
3. **RSS fallback (no key):** the public `/rss/` feed isn't challenged, but it's
   the *diary/review* feed - often far fewer films than the watched list (a user
   who logs films without diary entries can show just a handful). it's a last
   resort so you always get *something* instead of an error.

uploading your own poster images works anywhere, no backend needed.

both the TMDB key and the scraper key only ever live on the server
(`process.env`), never in the browser.

## 1. get a free TMDB api key

1. make an account at https://www.themoviedb.org/signup
2. go to https://www.themoviedb.org/settings/api -> request an api key (choose
   "Developer", it's instant and free)
3. copy the value labelled **API Key** (v3 auth). that's the string you need.

## 2. (recommended) get a free scraper api key

needed to import **arbitrary public profiles** from the deployed site (gets past
Cloudflare). pick any one - the function supports several:

| provider | free tier | `SCRAPER_PROVIDER` value |
|---|---|---|
| [ScraperAPI](https://www.scraperapi.com/) | ~1,000–5,000 / mo | `scraperapi` (default) |
| [ScrapingAnt](https://scrapingant.com/) | ~10,000 / mo | `scrapingant` |
| [ScrapingBee](https://www.scrapingbee.com/) | 1,000 trial | `scrapingbee` |
| [ZenRows](https://www.zenrows.com/) | trial | `zenrows` |

sign up, copy your api key. you'll add it as `SCRAPER_API_KEY` below. (skip this
and the site still runs - it just falls back to the RSS feed for imports.)

## 3. deploy to vercel

1. push these files to a new github repo.
2. at https://vercel.com -> Add New -> Project -> import the repo.
3. before clicking Deploy, open **Environment Variables** and add:
   - `TMDB_API_KEY` = your key from step 1
   - `SCRAPER_API_KEY` = your key from step 2 *(recommended)*
   - `SCRAPER_PROVIDER` = the value from the table *(only if not using the
     default `scraperapi`)*
4. Deploy. the included `vercel.json` builds `api/letterboxd.js` as a serverless
   function and serves `index.html` statically.
5. open your `*.vercel.app` url, paste any letterboxd username, hit Import.

if you ever change a key, update it in Project -> Settings -> Environment
Variables and redeploy.

**using a provider not in the table?** set `SCRAPER_URL_TEMPLATE` to its full
request URL with `{url}` where the (url-encoded) target goes, e.g.
`https://api.example.com/?key=YOURKEY&render=true&url={url}`.

## run it locally (optional)

```bash
npm i -g vercel
echo "TMDB_API_KEY=your_key_here" > .env
vercel dev
```

then open the local url it prints. `vercel dev` runs the `/api` function too.
locally your machine has a residential IP, so the **direct http/2** path usually
works for the full library without any scraper key (add `SCRAPER_API_KEY` to
`.env` too if you want to exercise that path).

## notes / tuning

- the function caps at 60 letterboxd pages (~4300 films). change `PAGE_CAP` in
  `api/letterboxd.js` if you somehow need more.
- scraper calls are slower (JS render) and credit-metered - one credit per
  letterboxd page, so a ~1,000-film library is ~14 credits per import. results
  are cached for 10 min, so a re-import within that window is free.
- a small number of films may come back without a poster if the TMDB title match
  is ambiguous; they show as a labelled placeholder you can still rank.
- the 60s `maxDuration` budget is split between scraping and posters; a very
  large library that runs long returns what it gathered (the rest show as
  placeholders) rather than timing out. re-run to fill in the gaps.
