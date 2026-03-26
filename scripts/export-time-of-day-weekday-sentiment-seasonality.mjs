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
  console.log(`Usage: npm run report:sentiment-seasonality -- [lookbackDays=90] [topTickers=25] [minMentionsPerBucket=5]

Builds ticker-level intraday and weekday sentiment seasonality report.

Arguments:
  lookbackDays          Lookback window in days (default: 90)
  topTickers            Number of most-mentioned tickers to include (default: 25)
  minMentionsPerBucket  Minimum mentions per ticker/bucket (default: 5)

Core fields:
  ticker
  hour_utc or weekday
  avg_sentiment
  avg_mentions
  volatility_proxy

Output:
  data/reports/sentiment-seasonality/<UTC_TIMESTAMP>/sentiment-seasonality.csv
  data/reports/sentiment-seasonality/<UTC_TIMESTAMP>/sentiment-seasonality.json
  data/reports/sentiment-seasonality/<UTC_TIMESTAMP>/sentiment-seasonality.html

Examples:
  npm run report:sentiment-seasonality
  npm run report:sentiment-seasonality -- 120 30 8

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const lookbackDays = Number.parseInt(positionals[0] ?? "90", 10);
const topTickers = Number.parseInt(positionals[1] ?? "25", 10);
const minMentionsPerBucket = Number.parseInt(positionals[2] ?? "5", 10);

if (
  !Number.isInteger(lookbackDays) ||
  !Number.isInteger(topTickers) ||
  !Number.isInteger(minMentionsPerBucket) ||
  lookbackDays <= 0 ||
  topTickers <= 0 ||
  minMentionsPerBucket <= 0
) {
  console.error(
    "Usage: npm run report:sentiment-seasonality -- [lookbackDays=90] [topTickers=25] [minMentionsPerBucket=5]",
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

const intradaySql = `
WITH scoped AS (
  SELECT
    ts.ticker AS ticker,
    ts.ticker_sentiment_score AS score,
    strftime('%H', n.time_published) AS hour_utc,
    date(n.time_published) AS day_utc
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  WHERE datetime(n.time_published) >= datetime('now', '-${lookbackDays} days')
),
top_tickers AS (
  SELECT ticker
  FROM scoped
  GROUP BY ticker
  ORDER BY COUNT(*) DESC, ticker ASC
  LIMIT ${topTickers}
),
hourly_rollup AS (
  SELECT
    s.ticker,
    s.hour_utc,
    COUNT(*) AS mention_count,
    COUNT(DISTINCT s.day_utc) AS active_day_count,
    AVG(s.score) AS avg_sentiment
  FROM scoped s
  JOIN top_tickers tt ON tt.ticker = s.ticker
  GROUP BY s.ticker, s.hour_utc
  HAVING COUNT(*) >= ${minMentionsPerBucket}
),
hourly_volatility AS (
  SELECT
    hr.ticker,
    hr.hour_utc,
    AVG(ABS(s.score - hr.avg_sentiment)) AS volatility_proxy
  FROM hourly_rollup hr
  JOIN scoped s ON s.ticker = hr.ticker AND s.hour_utc = hr.hour_utc
  GROUP BY hr.ticker, hr.hour_utc
)
SELECT
  hr.ticker AS ticker,
  hr.hour_utc AS hour_utc,
  ROUND(hr.avg_sentiment, 4) AS avg_sentiment,
  ROUND((CAST(hr.mention_count AS REAL) / hr.active_day_count), 4) AS avg_mentions,
  ROUND(hv.volatility_proxy, 4) AS volatility_proxy
FROM hourly_rollup hr
JOIN hourly_volatility hv ON hv.ticker = hr.ticker AND hv.hour_utc = hr.hour_utc
ORDER BY hr.ticker ASC, hr.hour_utc ASC;
`;

const weekdaySql = `
WITH scoped AS (
  SELECT
    ts.ticker AS ticker,
    ts.ticker_sentiment_score AS score,
    CAST(strftime('%w', n.time_published) AS INTEGER) AS weekday_num,
    date(n.time_published) AS day_utc
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  WHERE datetime(n.time_published) >= datetime('now', '-${lookbackDays} days')
),
top_tickers AS (
  SELECT ticker
  FROM scoped
  GROUP BY ticker
  ORDER BY COUNT(*) DESC, ticker ASC
  LIMIT ${topTickers}
),
weekday_rollup AS (
  SELECT
    s.ticker,
    s.weekday_num,
    COUNT(*) AS mention_count,
    COUNT(DISTINCT s.day_utc) AS active_day_count,
    AVG(s.score) AS avg_sentiment
  FROM scoped s
  JOIN top_tickers tt ON tt.ticker = s.ticker
  GROUP BY s.ticker, s.weekday_num
  HAVING COUNT(*) >= ${minMentionsPerBucket}
),
weekday_volatility AS (
  SELECT
    wr.ticker,
    wr.weekday_num,
    AVG(ABS(s.score - wr.avg_sentiment)) AS volatility_proxy
  FROM weekday_rollup wr
  JOIN scoped s ON s.ticker = wr.ticker AND s.weekday_num = wr.weekday_num
  GROUP BY wr.ticker, wr.weekday_num
)
SELECT
  wr.ticker AS ticker,
  CASE wr.weekday_num
    WHEN 0 THEN 'Sunday'
    WHEN 1 THEN 'Monday'
    WHEN 2 THEN 'Tuesday'
    WHEN 3 THEN 'Wednesday'
    WHEN 4 THEN 'Thursday'
    WHEN 5 THEN 'Friday'
    ELSE 'Saturday'
  END AS weekday,
  ROUND(wr.avg_sentiment, 4) AS avg_sentiment,
  ROUND((CAST(wr.mention_count AS REAL) / wr.active_day_count), 4) AS avg_mentions,
  ROUND(wv.volatility_proxy, 4) AS volatility_proxy,
  wr.weekday_num AS weekday_num
FROM weekday_rollup wr
JOIN weekday_volatility wv ON wv.ticker = wr.ticker AND wv.weekday_num = wr.weekday_num
ORDER BY wr.ticker ASC, wr.weekday_num ASC;
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const intradayRows = db.prepare(intradaySql).all();
  const weekdayRows = db.prepare(weekdaySql).all().map((row) => {
    const { weekday_num: _weekdayNum, ...rest } = row;
    return rest;
  });

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      lookback_days: lookbackDays,
      top_tickers: topTickers,
      min_mentions_per_bucket: minMentionsPerBucket,
    },
    intraday_seasonality: intradayRows,
    weekday_seasonality: weekdayRows,
  };

  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "sentiment-seasonality", timestamp);
  const csvPath = path.join(reportDir, "sentiment-seasonality.csv");
  const jsonPath = path.join(reportDir, "sentiment-seasonality.json");
  const chartPath = path.join(reportDir, "sentiment-seasonality.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csvHeader = "seasonality_type,ticker,hour_utc,weekday,avg_sentiment,avg_mentions,volatility_proxy";
  const intradayLines = intradayRows.map(
    (row) =>
      [
        "intraday",
        row.ticker,
        row.hour_utc,
        "",
        row.avg_sentiment,
        row.avg_mentions,
        row.volatility_proxy,
      ]
        .map(escapeCsv)
        .join(","),
  );
  const weekdayLines = weekdayRows.map(
    (row) =>
      [
        "weekday",
        row.ticker,
        "",
        row.weekday,
        row.avg_sentiment,
        row.avg_mentions,
        row.volatility_proxy,
      ]
        .map(escapeCsv)
        .join(","),
  );
  fs.writeFileSync(csvPath, `${csvHeader}\n${[...intradayLines, ...weekdayLines].join("\n")}\n`, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Time-of-Day and Weekday Sentiment Seasonality</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Time-of-day / day-of-week sentiment seasonality</h2>
  <p>Generated at ${payload.generated_at}</p>
  <p>Lookback = ${lookbackDays} days, top tickers = ${topTickers}, min mentions per bucket = ${minMentionsPerBucket}</p>
  <div id="intraday-mentions" style="width: 100%; height: 520px;"></div>
  <div id="intraday-sentiment" style="width: 100%; height: 520px;"></div>
  <div id="weekday-mentions" style="width: 100%; height: 520px;"></div>
  <div id="weekday-sentiment" style="width: 100%; height: 520px;"></div>
  <script>
    const payload = ${JSON.stringify(payload)};
    const intraday = payload.intraday_seasonality;
    const weekday = payload.weekday_seasonality;

    Plotly.newPlot("intraday-mentions", [{
      x: intraday.map((d) => d.hour_utc),
      y: intraday.map((d) => d.avg_mentions),
      mode: "markers",
      type: "scatter",
      marker: {
        size: intraday.map((d) => Math.max(7, d.volatility_proxy * 30 + 7)),
        color: intraday.map((d) => d.avg_sentiment),
        colorscale: "RdBu",
        reversescale: true,
        colorbar: { title: "avg_sentiment" }
      },
      text: intraday.map((d) => d.ticker + " | volatility=" + d.volatility_proxy),
      hovertemplate: "%{text}<br>hour_utc=%{x}<br>avg_mentions=%{y}<extra></extra>"
    }], {
      title: "Intraday seasonality: avg_mentions by hour_utc",
      xaxis: { title: "hour_utc" },
      yaxis: { title: "avg_mentions" }
    });

    Plotly.newPlot("intraday-sentiment", [{
      x: intraday.map((d) => d.hour_utc),
      y: intraday.map((d) => d.avg_sentiment),
      mode: "markers",
      type: "scatter",
      marker: {
        size: intraday.map((d) => Math.max(7, d.avg_mentions * 2 + 7)),
        color: intraday.map((d) => d.volatility_proxy),
        colorscale: "Viridis",
        colorbar: { title: "volatility_proxy" }
      },
      text: intraday.map((d) => d.ticker + " | avg_mentions=" + d.avg_mentions),
      hovertemplate: "%{text}<br>hour_utc=%{x}<br>avg_sentiment=%{y}<extra></extra>"
    }], {
      title: "Intraday seasonality: avg_sentiment by hour_utc",
      xaxis: { title: "hour_utc" },
      yaxis: { title: "avg_sentiment" }
    });

    Plotly.newPlot("weekday-mentions", [{
      x: weekday.map((d) => d.weekday),
      y: weekday.map((d) => d.avg_mentions),
      mode: "markers",
      type: "scatter",
      marker: {
        size: weekday.map((d) => Math.max(7, d.volatility_proxy * 30 + 7)),
        color: weekday.map((d) => d.avg_sentiment),
        colorscale: "RdBu",
        reversescale: true,
        colorbar: { title: "avg_sentiment" }
      },
      text: weekday.map((d) => d.ticker + " | volatility=" + d.volatility_proxy),
      hovertemplate: "%{text}<br>weekday=%{x}<br>avg_mentions=%{y}<extra></extra>"
    }], {
      title: "Weekday seasonality: avg_mentions by weekday",
      xaxis: { title: "weekday" },
      yaxis: { title: "avg_mentions" }
    });

    Plotly.newPlot("weekday-sentiment", [{
      x: weekday.map((d) => d.weekday),
      y: weekday.map((d) => d.avg_sentiment),
      mode: "markers",
      type: "scatter",
      marker: {
        size: weekday.map((d) => Math.max(7, d.avg_mentions * 2 + 7)),
        color: weekday.map((d) => d.volatility_proxy),
        colorscale: "Viridis",
        colorbar: { title: "volatility_proxy" }
      },
      text: weekday.map((d) => d.ticker + " | avg_mentions=" + d.avg_mentions),
      hovertemplate: "%{text}<br>weekday=%{x}<br>avg_sentiment=%{y}<extra></extra>"
    }], {
      title: "Weekday seasonality: avg_sentiment by weekday",
      xaxis: { title: "weekday" },
      yaxis: { title: "avg_sentiment" }
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote seasonality CSV to ${csvPath}`);
  console.log(`Wrote seasonality JSON to ${jsonPath}`);
  console.log(`Wrote seasonality chart to ${chartPath}`);
  console.log(
    `Config: lookbackDays=${lookbackDays}, topTickers=${topTickers}, minMentionsPerBucket=${minMentionsPerBucket}`,
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
