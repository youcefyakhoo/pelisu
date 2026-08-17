// PelisLatinoHD clone - catalog scraper
// Pulls a sample catalog from the site's open WordPress REST API into static JSON
// used by the static web app (site/).
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const BASE = "https://ev.pelislatinohd.com";
const API = `${BASE}/wp-json/wp/v2`;
const IMG = "https://image.tmdb.org/t/p";

// ---- config (tunable) ----
const CONFIG = {
  moviesPages: 0,               // 0 = all pages of the movie catalog
  moviesPerPage: 100,           // max items per movies API page
  perPage: 100,
  series: 0,                    // 0 = all 302 series
  episodesPerShow: 100,         // max episodes fetched per series (full seasons)
  recentEpisodes: 300,          // episodes for the "Nuevos Episodios" module
  tags: ["anime", "superhero", "cartoon"],
  tagPages: 3,                  // pages scraped per tag module
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "..", "site", "data");

// ---- helpers ----
async function fetchAPI(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

function one(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

function gallery(v) {
  // meta values arrive as arrays of strings
  const s = one(v);
  if (!s) return null;
  return s;
}

function firstNum(v) {
  const s = String(one(v) || "").trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function posterUrl(p) {
  if (!p) return null;
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${IMG}/w300${clean}`;
}
function backdropUrl(p) {
  if (!p) return null;
  const clean = p.startsWith("/") ? p : `/${p}`;
  return `${IMG}/w780${clean}`;
}
function embedUrl(id) {
  const clean = String(id || "").trim();
  return clean ? `https://playpaste.link/player/embed.php?id=${encodeURIComponent(clean)}` : null;
}
function embedUrlEp(id, se, ep) {
  return `https://playpaste.link/player/embed.php?id=${encodeURIComponent(String(id))}&se=${encodeURIComponent(String(se))}&ep=${encodeURIComponent(String(ep))}`;
}

// Synopsis from WP post content: the real text lives in `content.rendered`
// (the REST `excerpt` is empty). Return the first paragraph, stripping any
// extra <h2> titles and stray markup.
function cleanSynopsis(post) {
  const html = (post && post.content && post.content.rendered) || "";
  if (!html) return null;
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  const text = ((p ? p[1] : html))
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(text) || null;
}

// Parse DooPlay people meta: "[/poster.jpg;Name,Rol][/poster2.jpg;Name2]"
function parsePeople(v, imgSize = "w185") {
  const raw = String(one(v) || "");
  const out = [];
  const re = /\[([^;\]]*);([^\]]+)\]/g;
  let m;
  while ((m = re.exec(raw))) {
    const poster = m[1];
    const parts = m[2].split(",");
    const name = (parts.shift() || "").trim();
    const role = parts.join(",").trim();
    out.push({
      name,
      role: role || null,
      photo: poster ? `${IMG}/${imgSize}${poster.startsWith("/") ? poster : "/" + poster}` : null,
    });
  }
  return out;
}

async function total(urlPath) {
  const res = await fetch(`${API}/${urlPath}?per_page=5&_fields=id`, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
  });
  return {
    total: Number(res.headers.get("x-wp-total") || 0),
    pages: Number(res.headers.get("x-wp-totalpages") || 0),
  };
}

// Resolve keywords for items that have no synopsis. The WordPress API only
// exposes dtkeyword as numeric IDs (and there are 15k of them), so instead the
// names are parsed from each item's HTML page (`ul.post-keywrds`), which is
// exactly what the real site displays under "Sinopsis" for those titles.
async function resolveKeywords(items) {
  const targets = items.filter((it) => !it.synopsis && (it.keywordIds || []).length);
  if (!targets.length) return;
  const seen = new Set();
  console.log(`[scraper] fetching keyword names for ${targets.length} titles without synopsis...`);
  let done = 0;
  const worker = async (it) => {
    const url = `${BASE}/${it.type === "series" ? "series" : "movie"}/${encodeURIComponent(it.slug)}/`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
      if (!res.ok) return;
      const html = await res.text();
      const names = [];
      const re = /<ul class="post-keywrds">([\s\S]*?)<\/ul>/i;
      const m = html.match(re);
      if (m) {
        const liRe = /<li[^>]*>[\s\S]*?<a[^>]*>([^<]*)<\/a>/gi;
        let lm;
        while ((lm = liRe.exec(m[1]))) {
          const n = decodeEntities((lm[1] || "").trim());
          if (n && !names.includes(n)) names.push(n);
        }
      }
      it.keywords = names.slice(0, 10);
    } catch {}
    seen.add(it.slug);
    done++;
    if (done % 25 === 0 || done === targets.length) console.log(`[scraper]   keywords ${done}/${targets.length}`);
  };
  const concurrency = 6;
  for (let i = 0; i < targets.length; i += concurrency) {
    await Promise.all(targets.slice(i, i + concurrency).map(worker));
  }
}

// Decode HTML entities (e.g. "Action &amp; Adventure" -> "Action & Adventure").
// The WP REST API returns taxonomy names already entity-encoded; the front end
// escapes once more when rendering, so decode once here to avoid double escaping.
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#8211;/g, "–")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ---- scrapers ----
async function scrapeMoviesGenreCountries() {
  const [genres, countries] = await Promise.all([
    fetchAPI(`${API}/genres?per_page=100&_fields=id,name,slug,count`),
    fetchAPI(`${API}/dtcountry?per_page=100&_fields=id,name,slug,count`),
  ]);
  const genreMap = {};
  for (const g of genres || []) genreMap[g.id] = decodeEntities(g.name);
  const countryMap = {};
  for (const c of countries || []) countryMap[c.id] = decodeEntities(c.name);
  return {
    genres: (genres || []).map((g) => ({ ...g, name: decodeEntities(g.name) })),
    countries: (countries || []).map((c) => ({ ...c, name: decodeEntities(c.name) })),
    genreMap,
    countryMap,
    genreName: (id) => genreMap[id] || "",
    countryName: (id) => countryMap[id] || "",
  };
}

// Map a raw WP movies post into a catalog item. Shared by the full scraper
// and the incremental updater so both produce identical shapes.
function mapMovie(m, meta) {
  const { genreName, countryName } = meta;
  const metaObj = m.meta || {};
  const genres = (m.genres || []).map((g) => (typeof g === "object" ? g.id : g));
  const countryIds = (Array.isArray(m.dtcountry) ? m.dtcountry : []).map((c) => (typeof c === "object" ? c.id : c));
  const tmdb = gallery(metaObj.idtmdb) || gallery(metaObj.idtmbd);
  const embeddedId = gallery(metaObj.ids) || tmdb || m.id;
  return {
    id: m.id,
    type: "movie",
    title: decodeEntities((m.title && m.title.rendered || "").trim()),
    originalTitle: decodeEntities((m.original_title || "").trim()) || null,
    slug: m.slug,
    date: m.date || null,
    poster: posterUrl(gallery(metaObj.dt_poster)),
    backdrop: backdropUrl(gallery(metaObj.dt_backdrop)),
    year: firstNum(metaObj.release_date ? String(gallery(metaObj.release_date)).slice(0, 4) : null),
    rating: firstNum(metaObj.imdbRating),
    tmdbRating: firstNum(metaObj.vote_average),
    imdbVotes: firstNum(metaObj.imdbVotes),
    tmdbVotes: firstNum(metaObj.vote_count),
    rated: one(metaObj.Rated) || null,
    runtime: firstNum(metaObj.runtime),
    tmdb,
    embeddedId,
    genres,
    countries: countryIds,
    country: countryName(countryIds[0]) || null,
    director: parsePeople(metaObj.dt_dir),
    cast: parsePeople(metaObj.dt_cast),
    keywords: [], // filled in after keyword resolution
    keywordIds: (m.dtkeyword || []).map((k) => (typeof k === "object" ? k.id || k : k)),
    synopsis: cleanSynopsis(m),
  };
}

// Map a raw WP tvshows post into a catalog item (initial empty episodes).
function mapSeries(s, meta) {
  const { genreName, countryName } = meta;
  const metaObj = s.meta || {};
  const genres = (s.genres || []).map((g) => (typeof g === "object" ? g.id : g));
  const countryIds = (Array.isArray(s.dtcountry) ? s.dtcountry : []).map((c) => (typeof c === "object" ? c.id : c));
  const tmdb = gallery(metaObj.idtmdb) || gallery(metaObj.idtmbd);
  return {
    id: s.id,
    type: "series",
    title: decodeEntities((s.title && s.title.rendered || "").trim()),
    originalTitle: decodeEntities((s.original_title || "").trim()) || null,
    slug: s.slug,
    date: s.date || null,
    poster: posterUrl(gallery(metaObj.dt_poster)),
    backdrop: backdropUrl(gallery(metaObj.dt_backdrop)),
    year: firstNum(metaObj.release_date ? String(gallery(metaObj.release_date)).slice(0, 4) : null) || firstNum(metaObj.first_air_date ? String(gallery(metaObj.first_air_date)).slice(0, 4) : null),
    rating: firstNum(metaObj.imdbRating),
    tmdbRating: firstNum(metaObj.vote_average),
    imdbVotes: firstNum(metaObj.imdbVotes),
    tmdbVotes: firstNum(metaObj.vote_count),
    rated: one(metaObj.Rated) || null,
    tmdb,
    embeddedId: gallery(metaObj.ids) || tmdb || s.id,
    genres,
    countries: countryIds,
    country: countryName(countryIds[0]) || null,
    director: parsePeople(metaObj.dt_dir),
    creator: parsePeople(metaObj.dt_creator),
    cast: parsePeople(metaObj.dt_cast),
    keywords: [], // filled in after keyword resolution
    keywordIds: (s.dtkeyword || []).map((k) => (typeof k === "object" ? k.id || k : k)),
    synopsis: cleanSynopsis(s),
    seasons: firstNum(metaObj.number_of_seasons) || firstNum(metaObj.temporadas) || null,
    episodes: [],
    episodesCount: 0,
  };
}

async function scrapeMovies(meta) {
  const { genreName, countryName } = meta;
  const perPage = CONFIG.moviesPerPage;
  const out = [];
  let page = 1;
  while (true) {
    let raw;
    try {
      raw = await fetchAPI(`${API}/movies?per_page=${perPage}&page=${page}`);
    } catch (e) {
      console.log(`[scraper] movies page ${page}: ${e.message} (stop)`);
      break;
    }
    if (!Array.isArray(raw) || !raw.length) break;
    for (const m of raw) {
      out.push(mapMovie(m, meta));
    }
    console.log(`[scraper] movies page ${page} (+${raw.length}, total ${out.length})`);
    if (CONFIG.moviesPages > 0 && page >= CONFIG.moviesPages) break;
    if (raw.length < perPage) break;
    page++;
  }
  return out;
}

async function scrapeSeries(meta) {
  const { genreName, countryName } = meta;
  let page = 1;
  const out = [];
  while (true) {
    let raw;
    try {
      raw = await fetchAPI(`${API}/tvshows?per_page=100&page=${page}`);
    } catch (e) {
      console.log(`[scraper] series page ${page}: ${e.message} (stop)`);
      break;
    }
    if (!Array.isArray(raw) || !raw.length) break;
    for (const s of raw) {
      out.push(mapSeries(s, meta));
    }
    console.log(`[scraper] series page ${page} (+${raw.length}, total ${out.length})`);
    if (CONFIG.series > 0 && out.length >= CONFIG.series) {
      out.length = Math.min(out.length, CONFIG.series);
      break;
    }
    if (!raw.length || raw.length < 100) break;
    page++;
  }
  return out;
}

async function scrapeEpisodesForShow(show) {
  // The REST `serie`/`ids` filters are unreliable; parse the series HTML page
  // which contains the full seasons/episodes structure (same as the real site).
  const url = `${BASE}/series/${encodeURIComponent(show.slug)}/`;
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
    if (!res.ok) return [];
    html = await res.text();
  } catch (e) {
    return [];
  }

  const baseId = show.embeddedId || show.tmdb || show.id;
  const out = [];
  // each season block
  const seasonRe = /<div class='se-c'>([\s\S]*?)<\/div>\s*<\/div>/g;
  let sm;
  while ((sm = seasonRe.exec(html))) {
    const block = sm[1];
    const seT = block.match(/<span class='se-t[^']*'>([^<]*)<\/span>/);
    if (!seT) continue;
    const season = seT[1].trim();
    // each episode row
    const epRe = /<li[^>]*>[\s\S]*?<div class='numerando'>([^<]*)<\/div>[\s\S]*?<div class='episodiotitle'>([\s\S]*?)<\/div>[\s\S]*?<\/li>/g;
    let em;
    while ((em = epRe.exec(block))) {
      const numParts = em[1].split("-").map((s) => s.trim());
      const num = numParts.length > 1 ? numParts[1] : em[1].trim();
      const titleMatch = em[2].match(/([\s\S]*?)(?:<span class='date'>([^<]*)<\/span>)?\s*$/);
      const title = (titleMatch ? titleMatch[1] : em[2]).replace(/<[^>]+>/g, "").trim();
      const date = titleMatch && titleMatch[2] ? titleMatch[2].trim() : null;
      out.push({
        id: String(baseId),
        season,
        episode: String(num),
        title: title || `Episodio ${num}`,
        embedded: embedUrlEp(baseId, season, num),
        date,
      });
    }
  }
  out.sort((a, b) => a.season.localeCompare(b.season, "es", { numeric: true }) || Number(a.episode) - Number(b.episode));
  return out;
}

async function scrapeRecentEpisodes() {
  const out = [];
  const perPage = 100;
  const pages = Math.min(Math.ceil(CONFIG.recentEpisodes / perPage), 10);
  for (let page = 1; page <= pages; page++) {
    let eps;
    try {
      eps = await fetchAPI(`${API}/episodes?per_page=${perPage}&page=${page}`);
    } catch (e) {
      break;
    }
    if (!Array.isArray(eps) || !eps.length) break;
    for (const ep of eps) {
      const metaObj = ep.meta || {};
      const se = String(one(metaObj.temporada) ?? "1");
      const num = String(one(metaObj.episodio) ?? "");
      const id = one(metaObj.ids) || one(metaObj.idtmdb);
      const serie = String(one(metaObj.serie) || "");
      out.push({
        title: String(one(metaObj.episode_name) || (ep.title && ep.title.rendered) || `Episodio ${num}`),
        serie,
        season: se,
        episode: num,
        embedded: embedUrlEp(id, se, num),
        date: ep.date || null,
        slug: ep.slug || null,
      });
    }
    if (out.length >= CONFIG.recentEpisodes) break;
  }
  return out;
}

async function scrapeTagSlugs(tag, pages) {
  // tag modules on the real site: /tag/{slug}/ -> list of item slugs
  const slugs = [];
  for (let page = 1; page <= pages; page++) {
    const url = page === 1 ? `${BASE}/tag/${tag}/` : `${BASE}/tag/${tag}/page/${page}/`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
      if (!res.ok) break;
      const html = await res.text();
      const re = /<h3[^>]*>\s*<a[^>]*href="https:\/\/ev\.pelislatinohd\.com\/(?:peliculas|series)\/([^/#"]+)\/"/g;
      let m;
      while ((m = re.exec(html))) {
        let slug = decodeURIComponent(m[1]);
        if (slug && !slugs.includes(slug)) slugs.push(slug);
      }
      if (slugs.length >= 60) break;
    } catch (e) {
      break;
    }
  }
  return slugs;
}

export {
  BASE,
  API,
  CONFIG,
  fetchAPI,
  one,
  gallery,
  firstNum,
  posterUrl,
  backdropUrl,
  embedUrl,
  embedUrlEp,
  cleanSynopsis,
  parsePeople,
  decodeEntities,
  resolveKeywords,
  scrapeMoviesGenreCountries,
  scrapeEpisodesForShow,
  scrapeRecentEpisodes,
  mapMovie,
  mapSeries,
};

// ---- build ----
async function main() {
  console.log("[scraper] building metadata (genres/countries)...");
  const meta = await scrapeMoviesGenreCountries();

  console.log("[scraper] fetching movies...");
  const movies = await scrapeMovies(meta);

  console.log("[scraper] fetching series...");
  const series = await scrapeSeries(meta);

  console.log("[scraper] resolving keywords...");
  await resolveKeywords([...movies, ...series]);

  console.log("[scraper] fetching episodes per series...");
  for (let i = 0; i < series.length; i++) {
    const eps = await scrapeEpisodesForShow(series[i]);
    series[i].episodes = eps;
    series[i].episodesCount = eps.length;
    if ((i + 1) % 10 === 0 || i === series.length - 1)
      console.log(`[scraper]   series episodes ${i + 1}/${series.length}`);
  }

  console.log("[scraper] fetching recent episodes...");
  const recentEpisodes = await scrapeRecentEpisodes();

  console.log("[scraper] scraping tag modules...");
  const tags = {};
  for (const t of CONFIG.tags) {
    tags[t] = await scrapeTagSlugs(t, CONFIG.tagPages);
    console.log(`[scraper]   tag ${t}: ${tags[t].length} items`);
  }

  const [moviesTot, seriesTot, episodesTot] = await Promise.all([
    total("movies"),
    total("tvshows"),
    total("episodes"),
  ]);

  const catalog = {
    meta: {
      title: "PelisLatinoHD",
      base: BASE,
      generatedAt: new Date().toISOString(),
      total: {
        movies: moviesTot.total,
        series: seriesTot.total,
        episodes: episodesTot.total,
      },
    },
    movies,
    series,
    genres: meta.genreMap,
    genresList: meta.genres,
    countries: meta.countryMap,
    countriesList: meta.countries,
    find: (type, slug) =>
      (type === "movie" ? movies : series).find((x) => x.slug === slug) || null,
    tags,
    recentEpisodes,
  };

  mkdirSync(path.join(OUT, "meta"), { recursive: true });
  writeFileSync(path.join(OUT, "catalog.json"), JSON.stringify(catalog));
  writeFileSync(path.join(OUT, "meta", "genres.json"), JSON.stringify(meta.genreMap));
  writeFileSync(path.join(OUT, "meta", "countries.json"), JSON.stringify(meta.countryMap));
  console.log(`[scraper] Wrote catalog.json (movies=${movies.length}, series=${series.length}, genres=${Object.keys(meta.genreMap).length}, countries=${Object.keys(meta.countryMap).length})`);
}

// CLI entrypoint: only run the full build when executed directly
// (not when imported by scraper/update.mjs).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
export { main as runFullScrape };