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
  console.log(`Usage: npm run report:ticker-attention-spikes -- [recentDays=3] [baselineDays=21] [topN=25] [minRecentMentions=3] [topHeadlines=3] [minBaselineMentions=5]

Detects unusual jumps in ticker news volume compared to a prior baseline window.

Arguments:
  recentDays         Recent window size in days (default: 3)
  baselineDays       Baseline window size in days before recent window (default: 21)
  topN               Number of rows to output (default: 25)
  minRecentMentions  Minimum mentions in recent window (default: 3)
  topHeadlines       Number of recent headlines to include per ticker (default: 3)
  minBaselineMentions  Minimum baseline mentions required in prior window (default: 5)

Output:
  data/reports/ticker-attention-spikes/<UTC_TIMESTAMP>/ticker-attention-spikes.csv

Examples:
  npm run report:ticker-attention-spikes
  npm run report:ticker-attention-spikes -- 2 14 20 4 5 8

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const recentDays = Number.parseInt(positionals[0] ?? "3", 10);
const baselineDays = Number.parseInt(positionals[1] ?? "21", 10);
const topN = Number.parseInt(positionals[2] ?? "25", 10);
const minRecentMentions = Number.parseInt(positionals[3] ?? "3", 10);
const topHeadlines = Number.parseInt(positionals[4] ?? "3", 10);
const minBaselineMentions = Number.parseInt(positionals[5] ?? "5", 10);

if (
  !Number.isInteger(recentDays) ||
  !Number.isInteger(baselineDays) ||
  !Number.isInteger(topN) ||
  !Number.isInteger(minRecentMentions) ||
  !Number.isInteger(topHeadlines) ||
  !Number.isInteger(minBaselineMentions) ||
  recentDays <= 0 ||
  baselineDays <= 0 ||
  topN <= 0 ||
  minRecentMentions < 0 ||
  topHeadlines <= 0 ||
  minBaselineMentions < 0
) {
  console.error(
    "Usage: npm run report:ticker-attention-spikes -- [recentDays=3] [baselineDays=21] [topN=25] [minRecentMentions=3] [topHeadlines=3] [minBaselineMentions=5]",
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
WITH ticker_counts AS (
  SELECT
    ts.ticker AS ticker,
    SUM(
      CASE
        WHEN datetime(n.time_published) >= datetime('now', '-${recentDays} days') THEN 1
        ELSE 0
      END
    ) AS recent_count,
    SUM(
      CASE
        WHEN datetime(n.time_published) < datetime('now', '-${recentDays} days')
          AND datetime(n.time_published) >= datetime('now', '-${recentDays + baselineDays} days') THEN 1
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
    (CAST(baseline_count AS REAL) / ${baselineDays}) * ${recentDays} AS expected_count_raw,
    CASE
      WHEN baseline_count = 0 AND recent_count > 0 THEN 999.0
      WHEN baseline_count = 0 THEN 0.0
      ELSE CAST(recent_count AS REAL) / ((CAST(baseline_count AS REAL) / ${baselineDays}) * ${recentDays})
    END AS spike_ratio_raw,
    CASE
      WHEN baseline_count = 0 AND recent_count > 0 THEN 999.0
      WHEN baseline_count = 0 THEN 0.0
      ELSE
        (CAST(recent_count AS REAL) - ((CAST(baseline_count AS REAL) / ${baselineDays}) * ${recentDays}))
        / sqrt((CAST(baseline_count AS REAL) / ${baselineDays}) * ${recentDays})
    END AS spike_score_raw
  FROM ticker_counts
)
SELECT
  s.ticker,
  s.recent_count,
  s.baseline_count,
  ROUND(s.expected_count_raw, 4) AS expected_count,
  ROUND(s.spike_score_raw, 4) AS spike_score,
  ROUND(s.spike_ratio_raw, 4) AS spike_ratio,
  CASE
    WHEN s.baseline_count = 0 THEN 1
    ELSE 0
  END AS is_new_coverage,
  (
    SELECT GROUP_CONCAT(title, ' || ')
    FROM (
      SELECT n2.title
      FROM ticker_sentiment ts2
      JOIN news_items n2 ON n2.id = ts2.news_id
      WHERE ts2.ticker = s.ticker
        AND datetime(n2.time_published) >= datetime('now', '-${recentDays} days')
      ORDER BY datetime(n2.time_published) DESC
      LIMIT ${topHeadlines}
    )
  ) AS top_recent_headlines
FROM scored s
WHERE s.recent_count >= ${minRecentMentions}
  AND s.baseline_count >= ${minBaselineMentions}
ORDER BY s.spike_score_raw DESC, s.recent_count DESC, s.ticker ASC
LIMIT ${topN};
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const rows = db.prepare(sql).all();
  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "ticker-attention-spikes", timestamp);
  const outputPath = path.join(reportDir, "ticker-attention-spikes.csv");
  const chartPath = path.join(reportDir, "ticker-attention-spikes.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header =
    "ticker,recent_count,baseline_count,expected_count,spike_score,spike_ratio,is_new_coverage,top_recent_headlines";
  const lines = rows.map(
    (row) =>
      `${escapeCsv(row.ticker)},${row.recent_count},${row.baseline_count},${row.expected_count},${row.spike_score},${row.spike_ratio},${row.is_new_coverage},${escapeCsv(row.top_recent_headlines)}`,
  );
  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Ticker Attention Spike Report</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Ticker attention spike report</h2>
  <p>Generated at ${new Date().toISOString()}</p>
  <p>
    Filtering out low-history names with baseline_count < ${minBaselineMentions}.
  </p>
  <div id="comparable-spike-score" style="width: 100%; height: 520px;"></div>
  <div id="recent-vs-expected" style="width: 100%; height: 520px;"></div>
  <div id="new-coverage" style="width: 100%; height: 420px;"></div>
  <div id="details-table" style="width: 100%; height: 700px;"></div>
  <script>
    const rows = ${JSON.stringify(rows)};
    const comparable = rows
      .filter((d) => !d.is_new_coverage)
      .sort((a, b) => b.spike_score - a.spike_score);
    const newCoverage = rows
      .filter((d) => d.is_new_coverage)
      .sort((a, b) => b.recent_count - a.recent_count || a.ticker.localeCompare(b.ticker));
    const cappedComparableScore = comparable.map((d) => Math.min(d.spike_score, 30));

    Plotly.newPlot("comparable-spike-score", [{
      x: comparable.map((d) => d.ticker),
      y: cappedComparableScore,
      type: "bar",
      text: comparable.map((d) => "recent=" + d.recent_count + ", baseline=" + d.baseline_count + ", expected=" + d.expected_count + ", ratio=" + d.spike_ratio),
      hovertemplate: "%{x}<br>spike_score_capped=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "Comparable tickers: spike score (capped at 30 for readability)",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Spike score (z-like)" }
    });

    Plotly.newPlot("recent-vs-expected", [
      {
        x: comparable.map((d) => d.ticker),
        y: comparable.map((d) => d.recent_count),
        type: "bar",
        name: "Recent count"
      },
      {
        x: comparable.map((d) => d.ticker),
        y: comparable.map((d) => d.expected_count),
        type: "bar",
        name: "Expected count"
      }
    ], {
      barmode: "group",
      title: "Comparable tickers: recent vs expected mention counts",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Mentions" }
    });

    Plotly.newPlot("new-coverage", [{
      x: newCoverage.map((d) => d.ticker),
      y: newCoverage.map((d) => d.recent_count),
      type: "bar",
      text: newCoverage.map((d) => "baseline=0, expected=0"),
      hovertemplate: "%{x}<br>recent_count=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "New coverage tickers (baseline_count = 0), ranked by recent mentions",
      xaxis: { title: "Ticker" },
      yaxis: { title: "Recent mentions" }
    });

    Plotly.newPlot("details-table", [{
      type: "table",
      header: {
        values: [
          "<b>Ticker</b>",
          "<b>Recent</b>",
          "<b>Baseline</b>",
          "<b>Expected</b>",
          "<b>Spike score</b>",
          "<b>Spike ratio</b>",
          "<b>New coverage?</b>",
          "<b>Top recent headlines</b>"
        ],
        align: "left"
      },
      cells: {
        values: [
          rows.map((d) => d.ticker),
          rows.map((d) => d.recent_count),
          rows.map((d) => d.baseline_count),
          rows.map((d) => d.expected_count),
          rows.map((d) => d.spike_score),
          rows.map((d) => d.spike_ratio),
          rows.map((d) => d.is_new_coverage ? "yes" : "no"),
          rows.map((d) => (d.top_recent_headlines || "").split(" || ").join("<br>"))
        ],
        align: "left"
      }
    }], {
      title: "Ticker attention spike details"
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote ${rows.length} ticker attention spikes to ${outputPath}`);
  console.log(`Wrote chart to ${chartPath}`);
  console.log(
    `Config: recentDays=${recentDays}, baselineDays=${baselineDays}, topN=${topN}, minRecentMentions=${minRecentMentions}, topHeadlines=${topHeadlines}, minBaselineMentions=${minBaselineMentions}`,
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
