import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { startReportServer } from "./report-server.mjs";

dotenv.config();

function buildTimestampUtc() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run report:sentiment-regime-change -- [rollingDays=7] [lookbackDays=120] [topN=50] [minRollingMentions=8]

Finds tickers that flipped sentiment regime from net bearish to bullish (or bullish to bearish).

Arguments:
  rollingDays         Rolling window size in days for regime smoothing (default: 7)
  lookbackDays        Historical lookback window in days to scan for flips (default: 120)
  topN                Number of most recent flips to output (default: 50)
  minRollingMentions  Minimum total mentions inside each rolling window (default: 8)

Regime rules:
  rolling_avg_sentiment > 0   => Bullish
  rolling_avg_sentiment < 0   => Bearish
  rolling_avg_sentiment = 0   => Neutral
  (Only direct Bullish <-> Bearish flips are reported)

Output:
  data/reports/sentiment-regime-change/<UTC_TIMESTAMP>/sentiment-regime-change.csv

Examples:
  npm run report:sentiment-regime-change
  npm run report:sentiment-regime-change -- 10 180 100 12

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const rollingDays = Number.parseInt(positionals[0] ?? "7", 10);
const lookbackDays = Number.parseInt(positionals[1] ?? "120", 10);
const topN = Number.parseInt(positionals[2] ?? "50", 10);
const minRollingMentions = Number.parseInt(positionals[3] ?? "8", 10);

if (
  !Number.isInteger(rollingDays) ||
  !Number.isInteger(lookbackDays) ||
  !Number.isInteger(topN) ||
  !Number.isInteger(minRollingMentions) ||
  rollingDays <= 0 ||
  lookbackDays <= 0 ||
  topN <= 0 ||
  minRollingMentions <= 0
) {
  console.error(
    "Usage: npm run report:sentiment-regime-change -- [rollingDays=7] [lookbackDays=120] [topN=50] [minRollingMentions=8]",
  );
  process.exit(1);
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const configuredSqlitePath = process.env.SQLITE_PATH ?? "./data/news.db";
const configuredDatabasePath = path.isAbsolute(configuredSqlitePath)
  ? configuredSqlitePath
  : path.resolve(projectRoot, configuredSqlitePath);
const defaultLocalDatabasePath = path.resolve(projectRoot, "data", "news.db");
const databasePath = fs.existsSync(configuredDatabasePath)
  ? configuredDatabasePath
  : defaultLocalDatabasePath;

if (!fs.existsSync(databasePath)) {
  const fallbackNote =
    configuredDatabasePath !== defaultLocalDatabasePath
      ? ` (also checked local fallback ${defaultLocalDatabasePath})`
      : "";
  console.error(`SQLite DB not found at ${configuredDatabasePath}${fallbackNote}`);
  console.error("Set SQLITE_PATH in .env or run `npm run ingest-once` first.");
  process.exit(1);
}

const db = new Database(databasePath, { readonly: true });

const sql = `
WITH daily_scores AS (
  SELECT
    ts.ticker AS ticker,
    date(n.time_published) AS day,
    AVG(ts.ticker_sentiment_score) AS day_avg_sentiment,
    COUNT(*) AS day_mentions
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  WHERE datetime(n.time_published) >= datetime('now', '-${lookbackDays} days')
  GROUP BY ts.ticker, date(n.time_published)
),
rolling AS (
  SELECT
    ticker,
    day,
    AVG(day_avg_sentiment) OVER (
      PARTITION BY ticker
      ORDER BY day
      ROWS BETWEEN ${rollingDays - 1} PRECEDING AND CURRENT ROW
    ) AS rolling_avg_sentiment,
    COUNT(*) OVER (
      PARTITION BY ticker
      ORDER BY day
      ROWS BETWEEN ${rollingDays - 1} PRECEDING AND CURRENT ROW
    ) AS rolling_days_observed,
    SUM(day_mentions) OVER (
      PARTITION BY ticker
      ORDER BY day
      ROWS BETWEEN ${rollingDays - 1} PRECEDING AND CURRENT ROW
    ) AS rolling_mentions
  FROM daily_scores
),
classified AS (
  SELECT
    ticker,
    day,
    rolling_avg_sentiment,
    rolling_days_observed,
    rolling_mentions,
    CASE
      WHEN rolling_avg_sentiment > 0 THEN 'Bullish'
      WHEN rolling_avg_sentiment < 0 THEN 'Bearish'
      ELSE 'Neutral'
    END AS regime
  FROM rolling
),
flips AS (
  SELECT
    ticker,
    day AS flip_day,
    LAG(regime) OVER (PARTITION BY ticker ORDER BY day) AS prev_regime,
    regime AS current_regime,
    LAG(rolling_avg_sentiment) OVER (PARTITION BY ticker ORDER BY day) AS prev_rolling_avg_sentiment,
    rolling_avg_sentiment AS current_rolling_avg_sentiment
  FROM classified
  WHERE rolling_days_observed >= ${rollingDays}
    AND rolling_mentions >= ${minRollingMentions}
),
direct_flips AS (
  SELECT
    ticker,
    flip_day,
    prev_regime,
    current_regime,
    ABS(current_rolling_avg_sentiment - prev_rolling_avg_sentiment) AS flip_strength_raw,
    CAST(julianday('now') - julianday(flip_day) AS INTEGER) AS days_since_flip
  FROM flips
  WHERE (prev_regime = 'Bearish' AND current_regime = 'Bullish')
     OR (prev_regime = 'Bullish' AND current_regime = 'Bearish')
),
latest_flip_per_ticker AS (
  SELECT
    ticker,
    flip_day,
    prev_regime,
    current_regime,
    ROUND(flip_strength_raw, 4) AS flip_strength,
    days_since_flip,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY flip_day DESC) AS rank_in_ticker
  FROM direct_flips
)
SELECT
  ticker,
  prev_regime,
  current_regime,
  flip_strength,
  days_since_flip
FROM latest_flip_per_ticker
WHERE rank_in_ticker = 1
ORDER BY days_since_flip ASC, flip_strength DESC, ticker ASC
LIMIT ${topN};
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const rows = db.prepare(sql).all();
  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "sentiment-regime-change", timestamp);
  const outputPath = path.join(reportDir, "sentiment-regime-change.csv");
  const chartPath = path.join(reportDir, "sentiment-regime-change.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const header = "ticker,prev_regime,current_regime,flip_strength,days_since_flip";
  const lines = rows.map(
    (row) =>
      `${row.ticker},${row.prev_regime},${row.current_regime},${row.flip_strength},${row.days_since_flip}`,
  );
  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sentiment Regime Change Report</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Sentiment regime change report</h2>
  <p>Generated at ${new Date().toISOString()}</p>
  <p>
    Rolling window = ${rollingDays} days, lookback = ${lookbackDays} days,
    min rolling mentions = ${minRollingMentions}.
  </p>
  <div id="flip-strength" style="width: 100%; height: 480px;"></div>
  <div id="flip-table" style="width: 100%; height: 720px;"></div>
  <script>
    const rows = ${JSON.stringify(rows)};
    const labels = rows.map((d) => d.ticker);
    const colors = rows.map((d) => d.current_regime === "Bullish" ? "#2e7d32" : "#c62828");

    Plotly.newPlot("flip-strength", [{
      x: labels,
      y: rows.map((d) => d.flip_strength),
      type: "bar",
      marker: { color: colors },
      text: rows.map(
        (d) =>
          d.prev_regime +
          " -> " +
          d.current_regime +
          ", days_since_flip=" +
          d.days_since_flip,
      ),
      hovertemplate: "%{x}<br>flip_strength=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "Latest regime flips by ticker",
      xaxis: {
        title: "Ticker",
        tickangle: -45,
        automargin: true,
      },
      yaxis: { title: "Flip strength (abs delta rolling sentiment)" },
      margin: { t: 60, r: 20, b: 160, l: 70 }
    });

    Plotly.newPlot("flip-table", [{
      type: "table",
      header: {
        values: [
          "<b>Ticker</b>",
          "<b>Prev regime</b>",
          "<b>Current regime</b>",
          "<b>Flip strength</b>",
          "<b>Days since flip</b>"
        ],
        align: "left"
      },
      cells: {
        values: [
          rows.map((d) => d.ticker),
          rows.map((d) => d.prev_regime),
          rows.map((d) => d.current_regime),
          rows.map((d) => d.flip_strength),
          rows.map((d) => d.days_since_flip)
        ],
        align: "left"
      }
    }], {
      title: "Sentiment regime change details"
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote ${rows.length} sentiment regime flips to ${outputPath}`);
  console.log(`Wrote chart to ${chartPath}`);
  console.log(
    `Config: rollingDays=${rollingDays}, lookbackDays=${lookbackDays}, topN=${topN}, minRollingMentions=${minRollingMentions}`,
  );

  if (serveEnabled) {
    const requestedPort = Number.parseInt(process.env.REPORT_PORT ?? "8787", 10);
    const reportsRoot = path.resolve(projectRoot, "data", "reports");
    const { reportUrl, baseUrl } = await startReportServer({
      rootDir: reportsRoot,
      reportPath: chartPath,
      requestedPort: Number.isInteger(requestedPort) ? requestedPort : 8787,
    });
    console.log(`Reports server: ${baseUrl}`);
    console.log(`Open chart: ${reportUrl}`);
    console.log("Press Ctrl+C to stop.");
  }
} finally {
  db.close();
}
