// PelisLatinoHD clone - incremental catalog updater
// Worker that keeps site/data/catalog.json fresh without a full re-scrape:
// only fetches movies/series/episodes NEWER than the last generatedAt and
// merges them into the existing catalog. Safe to run repeatedly.
//
// Data living in `data/` at repo root (GitHub Pages layout) or `site/data/`
// (local repo layout) is detected automatically.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  API,
  CONFIG,
  fetchAPI,
  decodeEntities,
  resolveKeywords,
  scrapeMoviesGenreCountries,
  scrapeEpisodesForShow,
  scrapeRecentEpisodes,
  mapMovie,
  mapSeries,
} from "./scrape.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDataDir() {
  const candidates = [
    process.env.PELIS_DATA_DIR,
    path.resolve(__dirname, "..", "data"),
    path.resolve(__dirname, "..", "site", "data"),
  ].filter(Boolean).map((p) => path.resolve(p));
  const hit = candidates.find((p) => existsSync(path.join(p, "catalog.json")));
  return hit || candidates[0];
}

const OUT = resolveDataDir();
const CATALOG_PATH = path.join(OUT, "catalog.json");

// How many historical pages to scan for "new arrivals" when a content page
// published *before* the last crawl appears in recent results anyway.
const LOOKBACK_PAGES = 5;

// ---- helpers ----
function loadCatalog() {
  if (!existsSync(CATALOG_PATH)) return null;
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
}

function saveCatalog(catalog) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog));
  console.log(`[update] wrote ${CATALOG_PATH}`);
}

async function totals() {
  async function total(urlPath) {
    const res = await fetch(`${API}/${urlPath}?per_page=5&_fields=id`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    return Number(res.headers.get("x-wp-total") || 0);
  }
  return {
    movies: await total("movies"),
    series: await total("tvshows"),
    episodes: await total("episodes"),
  };
}

// Fetch all pages of a WP list endpoint newer than `after` (ISO), dedup by id,
// mapped with `mapper`. Returns { items, pageWithOldest } so we can also walk
// back a few pages to catch content back-dated before `after`.
async function fetchSince(endpoint, after, mapper, seenIds) {
  const out = [];
  let page = 1;
  let finished = false;
  while (page <= LOOKBACK_PAGES) {
    let raw;
    try {
      raw = await fetchAPI(`${API}/${endpoint}?per_page=100&page=${page}&after=${encodeURIComponent(after)}&orderby=date&order=desc`);
    } catch (e) {
      console.log(`[update] ${endpoint} page ${page}: ${e.message} (stop)`);
      break;
    }
    if (!Array.isArray(raw) || !raw.length) break;
    const fresh = raw.filter((x) => !seenIds.has(x.id));
    for (const x of fresh) out.push(mapper(x));
    for (const x of raw) seenIds.add(x.id);
    console.log(`[update]   ${endpoint} page ${page}: ${raw.length} posts (${fresh.length} new)`);
    if (raw.length < 100) {
      finished = true;
      break;
    }
    page++;
  }
  return out;
}

// Re-parse episodes for a series (handles new/updated seasons).
function refreshSeriesEpisodes(series) {
  return scrapeEpisodesForShow(series).then((eps) => {
    series.episodes = eps;
    series.episodesCount = eps.length;
  });
}

// ---- main ----
async function main() {
  console.log(`[update] data dir: ${OUT}`);
  if (!existsSync(CATALOG_PATH)) {
    console.error("[update] catalog.json not found - run `node scraper/scrape.mjs` first");
    process.exit(1);
  }

  const catalog = loadCatalog();
  const since = catalog.meta && catalog.meta.generatedAt
    ? catalog.meta.generatedAt
    : new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  console.log(`[update] since ${since}, existing: ${catalog.movies.length} movies, ${catalog.series.length} series, ${catalog.recentEpisodes.length} recent eps`);

  const movieIds = new Set(catalog.movies.map((m) => m.id));
  const seriesIds = new Set(catalog.series.map((s) => s.id));

  // Identify series that may have new/updated episodes: look at titles in the
  // recent-episodes feed first, then re-scrape those series' full episode tree.
  const recentFeed = await scrapeRecentEpisodes();
  const seriesTitleToSlug = Object.fromEntries(
    catalog.series.map((s) => [String(s.title).toLowerCase(), s])
  );

  // 1) New movies & series published since last crawl.
  const meta = await scrapeMoviesGenreCountries();
  console.log("[update] fetching new movies...");
  const newMovies = await fetchSince("movies", since, (m) => mapMovie(m, meta), movieIds);
  console.log("[update] fetching new series...");
  const newSeries = await fetchSince("tvshows", since, (s) => mapSeries(s, meta), seriesIds);

  // 2) New/updated episodes: any series touched by a recent episode whose title
  //    matches an existing (or brand new) series gets its episode list rebuilt.
  const affected = new Set();
  for (const ep of recentFeed) {
    const s = seriesTitleToSlug[String(ep.serie || "").toLowerCase()];
    if (s) affected.add(s.id);
  }
  for (const s of newSeries) affected.add(s.id);
  console.log(`[update] refreshing episodes for ${affected.size} series...`);
  for (const s of catalog.series) {
    if (affected.has(s.id)) await refreshSeriesEpisodes(s);
  }
  for (const ns of newSeries) await refreshSeriesEpisodes(ns);

  // 3) Merge.
  const beforeMovies = catalog.movies.length;
  const beforeSeries = catalog.series.length;
  catalog.movies = [...catalog.movies, ...newMovies];
  catalog.series = [...catalog.series, ...newSeries];

  // Merge genres/countries in case new items reference fresh taxonomies.
  catalog.genres = meta.genreMap;
  catalog.genresList = meta.genres;
  catalog.countries = meta.countryMap;
  catalog.countriesList = meta.countries;

  // 4) Refresh recent episodes (they drive the home module).
  const seenEpKey = new Set(catalog.recentEpisodes.map((e) => `${e.serie}|${e.season}|${e.episode}`));
  const mergedRecent = [
    ...recentFeed.filter((e) => {
      const k = `${e.serie}|${e.season}|${e.episode}`;
      if (seenEpKey.has(k)) return false;
      seenEpKey.add(k);
      return true;
    }),
    ...catalog.recentEpisodes,
  ].slice(0, CONFIG.recentEpisodes);

  catalog.recentEpisodes = mergedRecent;
  catalog.meta = catalog.meta || {};
  catalog.meta.generatedAt = new Date().toISOString();
  catalog.meta.total = await totals();

  saveCatalog(catalog);

  // meta/*.json stay in sync with genres/countries maps.
  mkdirSync(path.join(OUT, "meta"), { recursive: true });
  writeFileSync(path.join(OUT, "meta", "genres.json"), JSON.stringify(meta.genreMap));
  writeFileSync(path.join(OUT, "meta", "countries.json"), JSON.stringify(meta.countryMap));

  console.log(
    `[update] done: +${catalog.movies.length - beforeMovies} movies, ` +
    `+${catalog.series.length - beforeSeries} series, ` +
    `${mergedRecent.length} recent eps`
  );

  // Resolve keyword names only for items added in THIS run lacking a synopsis
  // (reuses full build logic, no re-fetching old titles every time).
  const fresh = [...newMovies, ...newSeries].filter(
    (it) => !it.synopsis && (it.keywordIds || []).length
  );
  if (fresh.length) await resolveKeywords(fresh);
  saveCatalog(catalog);
}

main()
  .then(() => {
    console.log("[update] OK");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });