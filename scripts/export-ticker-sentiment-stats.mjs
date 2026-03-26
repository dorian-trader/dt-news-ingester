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
  console.log(`Usage: npm run report:ticker-sentiment -- <TICKER>

Exports 12-month weekly and monthly average sentiment for one ticker.

Arguments:
  <TICKER>      Required ticker symbol (e.g. AAPL)

Output:
  data/reports/ticker-<ticker>-sentiment-stats/<UTC_TIMESTAMP>/ticker-<ticker>-sentiment-stats.json

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const inputTicker = positionals[0]?.trim().toUpperCase();
if (!inputTicker) {
  console.error("Usage: npm run report:ticker-sentiment -- <TICKER>");
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
if (configuredDatabasePath !== databasePath) {
  console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
}

const weeklySql = `
SELECT
  strftime('%Y-W%W', n.time_published) AS period,
  date(n.time_published, '-' || ((CAST(strftime('%w', n.time_published) AS INTEGER) + 6) % 7) || ' days') AS week_start,
  AVG(ts.ticker_sentiment_score) AS avg_sentiment,
  COUNT(*) AS article_count
FROM ticker_sentiment ts
JOIN news_items n ON n.id = ts.news_id
WHERE ts.ticker = ?
  AND datetime(n.time_published) >= datetime('now', '-12 months')
GROUP BY period, week_start
ORDER BY week_start ASC;
`;

const monthlySql = `
SELECT
  strftime('%Y-%m', n.time_published) AS period,
  strftime('%Y-%m-01', n.time_published) AS month_start,
  AVG(ts.ticker_sentiment_score) AS avg_sentiment,
  COUNT(*) AS article_count
FROM ticker_sentiment ts
JOIN news_items n ON n.id = ts.news_id
WHERE ts.ticker = ?
  AND datetime(n.time_published) >= datetime('now', '-12 months')
GROUP BY period, month_start
ORDER BY month_start ASC;
`;

try {
  const weekly = db.prepare(weeklySql).all(inputTicker);
  const monthly = db.prepare(monthlySql).all(inputTicker);

  const output = {
    ticker: inputTicker,
    window: {
      from: "now - 12 months",
      to: "now",
    },
    weekly,
    monthly,
  };

  const timestamp = buildTimestampUtc();
  const outputPath = path.resolve(
    projectRoot,
    "data",
    "reports",
    `ticker-${inputTicker.toLowerCase()}-sentiment-stats`,
    timestamp,
    `ticker-${inputTicker.toLowerCase()}-sentiment-stats.json`,
  );
  const chartPath = path.resolve(
    projectRoot,
    "data",
    "reports",
    `ticker-${inputTicker.toLowerCase()}-sentiment-stats`,
    timestamp,
    `ticker-${inputTicker.toLowerCase()}-sentiment-stats.html`,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${inputTicker} Sentiment Stats</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>${inputTicker} sentiment over time (last 12 months)</h2>
  <p>Generated at ${new Date().toISOString()}</p>
  <div id="sentiment" style="width: 100%; height: 560px;"></div>
  <div id="article-count" style="width: 100%; height: 460px;"></div>
  <script>
    const weekly = ${JSON.stringify(weekly)};
    const monthly = ${JSON.stringify(monthly)};
    const firstWeekByMonth = {};
    for (const row of weekly) {
      const monthKey = row.week_start.slice(0, 7);
      if (!firstWeekByMonth[monthKey]) {
        firstWeekByMonth[monthKey] = row.week_start;
      }
    }
    const monthlyBarRows = monthly
      .map((row) => ({
        ...row,
        bar_x: firstWeekByMonth[row.period] || row.month_start
      }))
      .filter((row) => Boolean(row.bar_x));

    Plotly.newPlot("sentiment", [
      {
        x: weekly.map((d) => d.week_start),
        y: weekly.map((d) => d.avg_sentiment),
        mode: "lines+markers",
        name: "Weekly avg sentiment",
        text: weekly.map((d) => d.period),
        hovertemplate: "Week %{text}<br>avg_sentiment=%{y}<extra></extra>"
      },
      {
        x: monthly.map((d) => d.month_start),
        y: monthly.map((d) => d.avg_sentiment),
        mode: "lines+markers",
        name: "Monthly avg sentiment",
        text: monthly.map((d) => d.period),
        hovertemplate: "Month %{text}<br>avg_sentiment=%{y}<extra></extra>"
      }
    ], {
      title: "${inputTicker} average sentiment",
      xaxis: { title: "Time", type: "date" },
      yaxis: { title: "Sentiment score" },
      shapes: [
        {
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: 0.35,
          y1: 0.35,
          line: { color: "#2e7d32", width: 2, dash: "dot" }
        },
        {
          type: "line",
          xref: "paper",
          x0: 0,
          x1: 1,
          yref: "y",
          y0: -0.35,
          y1: -0.35,
          line: { color: "#c62828", width: 2, dash: "dot" }
        }
      ],
      annotations: [
        {
          xref: "paper",
          x: 1,
          xanchor: "right",
          yref: "y",
          y: 0.35,
          text: "Bullish threshold (0.35)",
          showarrow: false,
          font: { color: "#2e7d32" },
          bgcolor: "rgba(255,255,255,0.7)"
        },
        {
          xref: "paper",
          x: 1,
          xanchor: "right",
          yref: "y",
          y: -0.35,
          text: "Bearish threshold (-0.35)",
          showarrow: false,
          font: { color: "#c62828" },
          bgcolor: "rgba(255,255,255,0.7)"
        }
      ]
    });

    Plotly.newPlot("article-count", [
      {
        x: weekly.map((d) => d.week_start),
        y: weekly.map((d) => d.article_count),
        type: "bar",
        name: "Weekly article count",
        text: weekly.map((d) => d.period),
        hovertemplate: "Week %{text}<br>articles=%{y}<extra></extra>"
      },
      {
        x: monthlyBarRows.map((d) => d.bar_x),
        y: monthlyBarRows.map((d) => d.article_count),
        type: "bar",
        name: "Monthly article count (at first week of month)",
        text: monthlyBarRows.map((d) => d.period),
        hovertemplate: "Month %{text}<br>articles=%{y}<extra></extra>"
      }
    ], {
      barmode: "group",
      title: "${inputTicker} article counts",
      xaxis: { title: "Time", type: "date" },
      yaxis: { title: "Articles" }
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");
  console.log(`Wrote sentiment stats for ${inputTicker} to ${outputPath}`);
  console.log(`Wrote chart for ${inputTicker} to ${chartPath}`);

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
