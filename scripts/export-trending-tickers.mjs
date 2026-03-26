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
  console.log(`Usage: npm run report:trending-tickers -- [recentDays=7] [baselineDays=28] [topN=10] [minRecentMentions=5]

Ranks recently trending tickers by momentum:
  (recent mentions/day) - (baseline mentions/day)

Arguments:
  recentDays         Recent window size in days (default: 7)
  baselineDays       Baseline window size in days before recent window (default: 28)
  topN               Number of rows to output (default: 10)
  minRecentMentions  Minimum mentions in recent window (default: 5)

Output:
  data/reports/trending-tickers/<UTC_TIMESTAMP>/trending-tickers.csv

Examples:
  npm run report:trending-tickers
  npm run report:trending-tickers -- 7 30 15 8

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const recentDays = Number.parseInt(positionals[0] ?? "7", 10);
const baselineDays = Number.parseInt(positionals[1] ?? "28", 10);
const topN = Number.parseInt(positionals[2] ?? "10", 10);
const minRecentMentions = Number.parseInt(positionals[3] ?? "5", 10);

if (
  !Number.isInteger(recentDays) ||
  !Number.isInteger(baselineDays) ||
  !Number.isInteger(topN) ||
  !Number.isInteger(minRecentMentions) ||
  recentDays <= 0 ||
  baselineDays <= 0 ||
  topN <= 0 ||
  minRecentMentions < 0
) {
  console.error(
    "Usage: npm run report:trending-tickers -- [recentDays=7] [baselineDays=28] [topN=10] [minRecentMentions=5]",
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

const sql = `
WITH ticker_counts AS (
  SELECT
    ts.ticker,
    SUM(
      CASE
        WHEN datetime(n.time_published) >= datetime('now', '-${recentDays} days')
        THEN 1
        ELSE 0
      END
    ) AS recent_count,
    SUM(
      CASE
        WHEN datetime(n.time_published) < datetime('now', '-${recentDays} days')
          AND datetime(n.time_published) >= datetime('now', '-${recentDays + baselineDays} days')
        THEN 1
        ELSE 0
      END
    ) AS baseline_count
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  GROUP BY ts.ticker
),
scored AS (
  SELECT
    ticker,
    recent_count,
    baseline_count,
    CAST(recent_count AS REAL) / ${recentDays} AS recent_per_day,
    CAST(baseline_count AS REAL) / ${baselineDays} AS baseline_per_day,
    (CAST(recent_count AS REAL) / ${recentDays}) - (CAST(baseline_count AS REAL) / ${baselineDays}) AS momentum_score,
    CASE
      WHEN baseline_count = 0 AND recent_count > 0 THEN 999.0
      WHEN baseline_count = 0 THEN 0.0
      ELSE (CAST(recent_count AS REAL) / ${recentDays}) / (CAST(baseline_count AS REAL) / ${baselineDays})
    END AS momentum_ratio
  FROM ticker_counts
)
SELECT
  ticker,
  recent_count,
  baseline_count,
  ROUND(recent_per_day, 4) AS recent_per_day,
  ROUND(baseline_per_day, 4) AS baseline_per_day,
  ROUND(momentum_score, 4) AS momentum_score,
  ROUND(momentum_ratio, 4) AS momentum_ratio
FROM scored
WHERE recent_count >= ${minRecentMentions}
ORDER BY momentum_score DESC, recent_count DESC, ticker ASC
LIMIT ${topN};
`;

const db = new Database(databasePath, { readonly: true });

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const rows = db.prepare(sql).all();

  const timestamp = buildTimestampUtc();
  const outputPath = path.resolve(
    projectRoot,
    "data",
    "reports",
    "trending-tickers",
    timestamp,
    "trending-tickers.csv",
  );
  const chartPath = path.resolve(
    projectRoot,
    "data",
    "reports",
    "trending-tickers",
    timestamp,
    "trending-tickers.html",
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const header =
    "ticker,recent_count,baseline_count,recent_per_day,baseline_per_day,momentum_score,momentum_ratio";
  const lines = rows.map(
    (row) =>
      `${row.ticker},${row.recent_count},${row.baseline_count},${row.recent_per_day},${row.baseline_per_day},${row.momentum_score},${row.momentum_ratio}`,
  );

  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");
  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trending Tickers</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Trending tickers</h2>
  <p>Generated at ${new Date().toISOString()}</p>
  <div id="rate-comparison" style="width: 100%; height: 560px;"></div>
  <div id="momentum-score" style="width: 100%; height: 460px;"></div>
  <script>
    const rows = ${JSON.stringify(rows)};
    const tickers = rows.map((d) => d.ticker);

    Plotly.newPlot("rate-comparison", [
      {
        x: tickers,
        y: rows.map((d) => d.recent_per_day),
        type: "bar",
        name: "Recent mentions/day"
      },
      {
        x: tickers,
        y: rows.map((d) => d.baseline_per_day),
        type: "bar",
        name: "Baseline mentions/day"
      }
    ], {
      barmode: "group",
      title: "Recent vs baseline mentions/day",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Mentions/day" }
    });

    Plotly.newPlot("momentum-score", [{
      x: tickers,
      y: rows.map((d) => d.momentum_score),
      type: "bar",
      text: rows.map((d) => "ratio: " + d.momentum_ratio),
      hovertemplate: "%{x}<br>momentum_score=%{y}<br>%{text}<extra></extra>",
      name: "Momentum score"
    }], {
      title: "Momentum score by ticker",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Momentum score" }
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");
  console.log(`Wrote ${rows.length} trending tickers to ${outputPath}`);
  console.log(`Wrote chart to ${chartPath}`);
  console.log(
    `Config: recentDays=${recentDays}, baselineDays=${baselineDays}, topN=${topN}, minRecentMentions=${minRecentMentions}`,
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
