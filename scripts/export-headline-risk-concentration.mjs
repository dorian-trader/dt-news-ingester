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
  console.log(`Usage: npm run report:headline-risk-concentration -- [lookbackHours=72] [topN=50] [minNegArticleCount=3] [minBearishPct=60] [topHeadlines=3]

Finds tickers with concentrated negative sentiment in a short time window.

Arguments:
  lookbackHours      Recent window size in hours (default: 72)
  topN               Number of rows to output (default: 50)
  minNegArticleCount Minimum bearish/somewhat-bearish article count (default: 3)
  minBearishPct      Minimum bearish label concentration percentage (default: 60)
  topHeadlines       Number of worst negative headlines to include per ticker (default: 3)

Output:
  data/reports/headline-risk-concentration/<UTC_TIMESTAMP>/headline-risk-concentration.csv

Examples:
  npm run report:headline-risk-concentration
  npm run report:headline-risk-concentration -- 24 30 4 65 5

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const lookbackHours = Number.parseInt(positionals[0] ?? "72", 10);
const topN = Number.parseInt(positionals[1] ?? "50", 10);
const minNegArticleCount = Number.parseInt(positionals[2] ?? "3", 10);
const minBearishPct = Number.parseInt(positionals[3] ?? "60", 10);
const topHeadlines = Number.parseInt(positionals[4] ?? "3", 10);

if (
  !Number.isInteger(lookbackHours) ||
  !Number.isInteger(topN) ||
  !Number.isInteger(minNegArticleCount) ||
  !Number.isInteger(minBearishPct) ||
  !Number.isInteger(topHeadlines) ||
  lookbackHours <= 0 ||
  topN <= 0 ||
  minNegArticleCount <= 0 ||
  minBearishPct < 0 ||
  minBearishPct > 100 ||
  topHeadlines <= 0
) {
  console.error(
    "Usage: npm run report:headline-risk-concentration -- [lookbackHours=72] [topN=50] [minNegArticleCount=3] [minBearishPct=60] [topHeadlines=3]",
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
WITH scoped AS (
  SELECT
    ts.ticker AS ticker,
    n.title AS title,
    n.time_published AS time_published,
    ts.ticker_sentiment_score AS ticker_sentiment_score,
    ts.ticker_sentiment_label AS ticker_sentiment_label,
    CASE
      WHEN ts.ticker_sentiment_label IN ('Bearish', 'Somewhat-Bearish') THEN 1
      ELSE 0
    END AS is_negative
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  WHERE datetime(n.time_published) >= datetime('now', '-${lookbackHours} hours')
),
ticker_rollup AS (
  SELECT
    ticker,
    COUNT(*) AS article_count,
    SUM(is_negative) AS neg_article_count
  FROM scoped
  GROUP BY ticker
),
negative_hourly AS (
  SELECT
    ticker,
    strftime('%Y-%m-%dT%H:00:00Z', time_published) AS hour_bucket,
    COUNT(*) AS neg_in_hour
  FROM scoped
  WHERE is_negative = 1
  GROUP BY ticker, hour_bucket
),
hourly_peak AS (
  SELECT
    ticker,
    MAX(neg_in_hour) AS peak_neg_in_hour
  FROM negative_hourly
  GROUP BY ticker
)
SELECT
  tr.ticker,
  tr.neg_article_count,
  ROUND((CAST(tr.neg_article_count AS REAL) * 100.0) / tr.article_count, 2) AS bearish_labels_pct,
  COALESCE((
    SELECT GROUP_CONCAT(title, ' || ')
    FROM (
      SELECT s2.title
      FROM scoped s2
      WHERE s2.ticker = tr.ticker
        AND s2.is_negative = 1
      ORDER BY s2.ticker_sentiment_score ASC, datetime(s2.time_published) DESC
      LIMIT ${topHeadlines}
    )
  ), '') AS worst_headlines,
  ROUND(
    CASE
      WHEN tr.neg_article_count = 0 THEN 0.0
      ELSE (COALESCE(hp.peak_neg_in_hour, 0) * 1.0) / (CAST(tr.neg_article_count AS REAL) / ${lookbackHours})
    END,
    4
  ) AS time_cluster_score
FROM ticker_rollup tr
LEFT JOIN hourly_peak hp ON hp.ticker = tr.ticker
WHERE tr.neg_article_count >= ${minNegArticleCount}
  AND ((CAST(tr.neg_article_count AS REAL) * 100.0) / tr.article_count) >= ${minBearishPct}
ORDER BY time_cluster_score DESC, tr.neg_article_count DESC, bearish_labels_pct DESC, tr.ticker ASC
LIMIT ${topN};
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const rows = db.prepare(sql).all();
  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "headline-risk-concentration", timestamp);
  const outputPath = path.join(reportDir, "headline-risk-concentration.csv");
  const chartPath = path.join(reportDir, "headline-risk-concentration.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = "ticker,neg_article_count,%bearish_labels,worst_headlines,time_cluster_score";
  const lines = rows.map(
    (row) =>
      `${escapeCsv(row.ticker)},${row.neg_article_count},${row.bearish_labels_pct},${escapeCsv(row.worst_headlines)},${row.time_cluster_score}`,
  );
  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Headline Risk Concentration Report</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Headline risk concentration report</h2>
  <p>Generated at ${new Date().toISOString()}</p>
  <p>
    Window = ${lookbackHours}h, min negative articles = ${minNegArticleCount},
    min bearish concentration = ${minBearishPct}%.
  </p>
  <div id="cluster-score" style="width: 100%; height: 520px;"></div>
  <div id="neg-vs-bearish" style="width: 100%; height: 520px;"></div>
  <div id="details-table" style="width: 100%; height: 760px;"></div>
  <script>
    const rows = ${JSON.stringify(rows)};

    Plotly.newPlot("cluster-score", [{
      x: rows.map((d) => d.ticker),
      y: rows.map((d) => d.time_cluster_score),
      type: "bar",
      marker: { color: "#c62828" },
      text: rows.map((d) => "neg=" + d.neg_article_count + ", bearish%=" + d.bearish_labels_pct),
      hovertemplate: "%{x}<br>time_cluster_score=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "Negative headline time-cluster score by ticker",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Time cluster score (higher = tighter burst)" }
    });

    Plotly.newPlot("neg-vs-bearish", [
      {
        x: rows.map((d) => d.ticker),
        y: rows.map((d) => d.neg_article_count),
        type: "bar",
        name: "Negative article count"
      },
      {
        x: rows.map((d) => d.ticker),
        y: rows.map((d) => d.bearish_labels_pct),
        type: "scatter",
        mode: "lines+markers",
        yaxis: "y2",
        name: "% bearish labels"
      }
    ], {
      title: "Negative volume vs bearish concentration",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Negative article count" },
      yaxis2: { title: "% bearish labels", overlaying: "y", side: "right", range: [0, 100] }
    });

    Plotly.newPlot("details-table", [{
      type: "table",
      header: {
        values: [
          "<b>Ticker</b>",
          "<b>Negative articles</b>",
          "<b>% Bearish labels</b>",
          "<b>Time cluster score</b>",
          "<b>Worst headlines</b>"
        ],
        align: "left"
      },
      cells: {
        values: [
          rows.map((d) => d.ticker),
          rows.map((d) => d.neg_article_count),
          rows.map((d) => d.bearish_labels_pct),
          rows.map((d) => d.time_cluster_score),
          rows.map((d) => (d.worst_headlines || "").split(" || ").join("<br>"))
        ],
        align: "left"
      }
    }], {
      title: "Headline risk concentration details"
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote ${rows.length} headline risk rows to ${outputPath}`);
  console.log(`Wrote chart to ${chartPath}`);
  console.log(
    `Config: lookbackHours=${lookbackHours}, topN=${topN}, minNegArticleCount=${minNegArticleCount}, minBearishPct=${minBearishPct}, topHeadlines=${topHeadlines}`,
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
