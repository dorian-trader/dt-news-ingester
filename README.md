# dt-news-ingester

Small **TypeScript** service that polls [Alpha Vantage **NEWS_SENTIMENT**](https://www.alphavantage.co/documentation/) every **5 minutes** (no `tickers` filter — the latest global feed up to **`ALPHA_VANTAGE_LIMIT`**), maps articles to a typed model, **dedupes** rows with `sha256(url + "|" + raw_time_published)`, and stores them in **SQLite** with a normalized schema suited for sentiment time series, author rollups, and per-article ticker facets.

## Prerequisites

- **Node.js 20+** (local dev), or **Docker** (recommended for running on a server)
- A free **Alpha Vantage API key** ([get one here](https://www.alphavantage.co/support/#api-key))

## Quick start (local)

1. **Clone** the repository and enter the directory.

2. **Install dependencies** and build:

   ```bash
   npm install
   npm run build
   ```

3. **Configure environment** — copy the example file and edit values:

   ```bash
   cp .env.example .env
   ```

   | Variable | Required | Description |
   | --- | --- | --- |
   | `ALPHA_VANTAGE_API_KEY` | Yes | Your Alpha Vantage key |
   | `ALPHA_VANTAGE_LIMIT` | No | Items per request, 1–1000 (default `50`) |
   | `SQLITE_PATH` | No | SQLite file path. Default in **code** is `./data/news.db` when unset; the **Docker image** sets `/data/news.db` (overridden if your `--env-file` sets a relative path — see [Docker](#docker)) |
| `SQLITE_JOURNAL_MODE` | No | SQLite journal mode (default `WAL`). Set `DELETE` for Docker Desktop bind mounts on Windows if WAL raises `SQLITE_IOERR_SHMOPEN` |
   | `INGEST_ONCE` | No | Set to `1` or `true` to run a **single** ingest and exit |

4. **Initialize the database** — the app applies `src/schema.sql` automatically on startup (no manual migration step). With a `.env` file in the project root, `dotenv` loads it automatically. Loading data for the first time:

   ```bash
   npm run ingest-once
   ```

5. (Optional) **Backfill a historical window** (idempotent; safe to stop/start):

   ```bash
   npm run backfill
   ```

   The backfill runner loads a dedicated env file (`.env.backfill` by default). Create it based on `.env.example` and set:

   - `ALPHA_VANTAGE_LIMIT=1000` (recommended)
   - `BACKFILL_LOWER_BOUND` / `BACKFILL_UPPER_BOUND`
   - `BACKFILL_MAX_REQUESTS_PER_MINUTE` (default `50`, hard cap `75`) or `BACKFILL_MIN_MS_BETWEEN_REQUESTS` for exact spacing between API calls

   `time_from` / `time_to` are minute-precision. If one minute still returns **`ALPHA_VANTAGE_LIMIT`** articles, the backfill **stores those rows and continues** (Alpha Vantage may omit additional articles that minute).

   To use a different env filename/location, set `BACKFILL_ENV_FILE` (e.g. `BACKFILL_ENV_FILE=.env.backfill.production`).

  **Same `news.db` as Docker + host backfill:** The app defaults to SQLite **WAL** mode and a **30s** busy timeout so two processes can share one file more safely. On **Windows + Docker Desktop**, bind mounts can fail to open WAL shared-memory files and raise `SQLITE_IOERR_SHMOPEN`. If that happens, set `SQLITE_JOURNAL_MODE=DELETE` for the container (or in your Docker env file). You may still see `news.db-wal` / `news.db-shm` from previous WAL runs; that is normal.

   Or run the continuous **5-minute** loop:

   ```bash
   npm start
   ```

   For development with auto-reload:

   ```bash
   npx tsx watch src/index.ts
   ```

## Docker

1. **Build** the image:

   ```bash
   docker build -t dt-news-ingester .
   ```

2. **Run** with the database **outside** the container (host directory `./data`):

   ```bash
   docker run --rm -d \
     --name dt-news-ingester \
     -e ALPHA_VANTAGE_API_KEY=your_key_here \
     -e ALPHA_VANTAGE_LIMIT=50 \
     -v "${PWD}/data:/data" \
     dt-news-ingester
   ```

   On **Linux/macOS**, replace the volume with `-v "$(pwd)/data:/data"`. On **PowerShell**, `"${PWD}/data:/data"` is correct for Docker Desktop.

   The image sets `SQLITE_PATH=/data/news.db`, which matches the mount above.

   **`--env-file .env` and `SQLITE_PATH`:** If your `.env` contains `SQLITE_PATH=./data/news.db` (meant for local npm), Docker still applies that variable inside the container. A **relative** path is resolved from the process working directory (`/app`), so the database becomes **`/app/data/news.db`** — inside the image layer, **not** on the bind mount at `/data`. You then get a “fresh” DB every run and **no** `-wal`/`-shm` next to the host files under `./data`. Fix any of these:

   - Pass **`--env-file .env` and then override** (last wins):  
     `-e SQLITE_PATH=/data/news.db`
   - Or **remove** `SQLITE_PATH` from the file you feed to Docker and rely on the image default.
   - Or keep a separate env file for Docker with `SQLITE_PATH=/data/news.db`.

3. **One-shot ingest** (useful after first deploy):

   ```bash
   docker run --rm \
     -e ALPHA_VANTAGE_API_KEY=your_key_here \
     -e INGEST_ONCE=1 \
     -v "${PWD}/data:/data" \
     dt-news-ingester
   ```

## Schema (SQLite)

- **`news_items`** — one row per article (`id` = hash). Indexed on `time_published`, `overall_sentiment_label`, `source`, and a composite on `(time_published, overall_sentiment_score)` for rolling analytics.
- **`news_authors`** — `(news_id, author)` for **author bias** / volume queries.
- **`news_topics`** — topic tags with `relevance_score`.
- **`ticker_sentiment`** — per-ticker scores and labels; indexed by `ticker` and `(ticker, ticker_sentiment_score)`.

The canonical SQL lives in `src/schema.sql` (copied next to `dist/` when you `npm run build`).

## Example queries

Point `sqlite3` at the same file as `SQLITE_PATH` (e.g. `./data/news.db` or `/data/news.db` in the container).

**Average overall sentiment by day** (`time_published` is stored as ISO-8601 UTC text):

```sql
SELECT date(time_published) AS day,
       AVG(overall_sentiment_score) AS avg_score,
       COUNT(*) AS n
FROM news_items
GROUP BY day
ORDER BY day DESC;
```

**News for a ticker** (e.g. AAPL):

```sql
SELECT n.time_published, n.title, n.url, n.overall_sentiment_label,
       t.ticker_sentiment_score, t.ticker_sentiment_label
FROM news_items n
JOIN ticker_sentiment t ON t.news_id = n.id
WHERE t.ticker = 'AAPL'
ORDER BY n.time_published DESC
LIMIT 50;
```

**Author “bias”** — average sentiment of articles where an author appears (handle duplicate author strings across outlets with care):

```sql
SELECT a.author,
       COUNT(*) AS articles,
       AVG(n.overall_sentiment_score) AS avg_overall_score
FROM news_authors a
JOIN news_items n ON n.id = a.news_id
GROUP BY a.author
HAVING articles >= 5
ORDER BY avg_overall_score ASC;
```

## Notes

- Alpha Vantage free tiers enforce tight **rate limits**; hitting limits surfaces as an `Information` / `Note` response and the app logs an error. A **5-minute** interval is usually safe for light usage; adjust if your plan allows more throughput.
- `time_published` from the API is parsed from `YYYYMMDDTHHMMSS` into a `Date` and stored as **ISO UTC** for stable sorting and `date()` grouping.
- Sentiment labels are normalized to: `Bearish`, `Somewhat-Bearish`, `Neutral`, `Somewhat-Bullish`, `Bullish`; unknown values map to `Neutral`.
