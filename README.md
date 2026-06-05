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

- **deployed (this repo on vercel):** pulls your *entire* watched list from
  letterboxd and grabs posters from TMDB. needs the `TMDB_API_KEY` env var below.
- **opened locally with no backend:** automatically falls back to letterboxd's
  public RSS feed, which only returns your ~50 most recent films. uploading your
  own images works anywhere.

the TMDB key only ever lives on the server (`process.env`), never in the browser.

## 1. get a free TMDB api key

1. make an account at https://www.themoviedb.org/signup
2. go to https://www.themoviedb.org/settings/api -> request an api key (choose
   "Developer", it's instant and free)
3. copy the value labelled **API Key** (v3 auth). that's the string you need.

## 2. deploy to vercel

1. push these files to a new github repo.
2. at https://vercel.com -> Add New -> Project -> import the repo.
3. before clicking Deploy, open **Environment Variables** and add:
   - name: `TMDB_API_KEY`
   - value: your key from step 1
4. Deploy. vercel auto-detects the `/api` folder as a serverless function, no
   build settings needed.
5. open your `*.vercel.app` url, paste your letterboxd username, hit Import.

if you ever change the key, update it in Project -> Settings -> Environment
Variables and redeploy.

## run it locally (optional)

```bash
npm i -g vercel
echo "TMDB_API_KEY=your_key_here" > .env
vercel dev
```

then open the local url it prints. `vercel dev` runs the `/api` function too, so
you get the full-library import on your machine.

## notes / tuning

- the function caps at 60 letterboxd pages (~4300 films). change `PAGE_CAP` in
  `api/letterboxd.js` if you somehow need more.
- a small number of films may come back without a poster if the TMDB title match
  is ambiguous; they show as a labelled placeholder you can still rank.
- on vercel's free tier, very large libraries can occasionally hit the function
  time limit. it's set to 60s via `maxDuration`. if you hit it, re-run (results
  are cached for 10 min) or lower `PAGE_CAP`.
