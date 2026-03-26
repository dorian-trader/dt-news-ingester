import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { startReportServer } from "./report-server.mjs";

dotenv.config();

function buildTimestampUtc() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Number(((numerator * 100.0) / denominator).toFixed(2));
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run report:news-breadth-market-tone -- [recentDays=7] [baselineDays=28] [topN=10] [minTopicMentions=3] [minTickerMentions=5]

Builds a market-wide dashboard with breadth, tone, trending topics, and ticker sentiment movers.

Arguments:
  recentDays         Recent window size in days (default: 7)
  baselineDays       Baseline window size in days before recent window (default: 28)
  topN               Number of topics/tickers to include in top lists (default: 10)
  minTopicMentions   Minimum topic mentions in recent window (default: 3)
  minTickerMentions  Minimum ticker mentions in both windows (default: 5)

Core fields:
  %bullish_articles
  %bearish_articles
  median_sentiment
  top_trending_topics
  top_ticker_flips

Output:
  data/reports/news-breadth-market-tone/<UTC_TIMESTAMP>/news-breadth-market-tone.csv
  data/reports/news-breadth-market-tone/<UTC_TIMESTAMP>/news-breadth-market-tone.json
  data/reports/news-breadth-market-tone/<UTC_TIMESTAMP>/news-breadth-market-tone.html

Examples:
  npm run report:news-breadth-market-tone
  npm run report:news-breadth-market-tone -- 5 21 15 4 8

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
const minTopicMentions = Number.parseInt(positionals[3] ?? "3", 10);
const minTickerMentions = Number.parseInt(positionals[4] ?? "5", 10);

if (
  !Number.isInteger(recentDays) ||
  !Number.isInteger(baselineDays) ||
  !Number.isInteger(topN) ||
  !Number.isInteger(minTopicMentions) ||
  !Number.isInteger(minTickerMentions) ||
  recentDays <= 0 ||
  baselineDays <= 0 ||
  topN <= 0 ||
  minTopicMentions <= 0 ||
  minTickerMentions <= 0
) {
  console.error(
    "Usage: npm run report:news-breadth-market-tone -- [recentDays=7] [baselineDays=28] [topN=10] [minTopicMentions=3] [minTickerMentions=5]",
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

const breadthSql = `
WITH scoped AS (
  SELECT
    overall_sentiment_score AS score,
    overall_sentiment_label AS label
  FROM news_items
  WHERE datetime(time_published) >= datetime('now', '-${recentDays} days')
),
ordered AS (
  SELECT
    score,
    ROW_NUMBER() OVER (ORDER BY score) AS rn,
    COUNT(*) OVER () AS cnt
  FROM scoped
)
SELECT
  COUNT(*) AS total_articles,
  SUM(CASE WHEN label IN ('Bullish', 'Somewhat-Bullish') THEN 1 ELSE 0 END) AS bullish_articles,
  SUM(CASE WHEN label IN ('Bearish', 'Somewhat-Bearish') THEN 1 ELSE 0 END) AS bearish_articles,
  COALESCE((
    SELECT AVG(score)
    FROM ordered
    WHERE rn IN (CAST((cnt + 1) / 2 AS INTEGER), CAST((cnt + 2) / 2 AS INTEGER))
  ), 0.0) AS median_sentiment
FROM scoped;
`;

const topicsSql = `
WITH topic_counts AS (
  SELECT
    nt.topic,
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
  FROM news_topics nt
  JOIN news_items n ON n.id = nt.news_id
  GROUP BY nt.topic
),
scored AS (
  SELECT
    topic,
    recent_count,
    baseline_count,
    CAST(recent_count AS REAL) / ${recentDays} AS recent_per_day,
    CAST(baseline_count AS REAL) / ${baselineDays} AS baseline_per_day,
    (CAST(recent_count AS REAL) / ${recentDays}) - (CAST(baseline_count AS REAL) / ${baselineDays}) AS momentum_score
  FROM topic_counts
)
SELECT
  topic,
  recent_count,
  baseline_count,
  ROUND(recent_per_day, 4) AS recent_per_day,
  ROUND(baseline_per_day, 4) AS baseline_per_day,
  ROUND(momentum_score, 4) AS momentum_score
FROM scored
WHERE recent_count >= ${minTopicMentions}
ORDER BY momentum_score DESC, recent_count DESC, topic ASC
LIMIT ${topN};
`;

const tickerFlipsSql = `
WITH ticker_window AS (
  SELECT
    ts.ticker,
    AVG(
      CASE
        WHEN datetime(n.time_published) >= datetime('now', '-${recentDays} days')
        THEN ts.ticker_sentiment_score
      END
    ) AS recent_avg_sentiment,
    AVG(
      CASE
        WHEN datetime(n.time_published) < datetime('now', '-${recentDays} days')
          AND datetime(n.time_published) >= datetime('now', '-${recentDays + baselineDays} days')
        THEN ts.ticker_sentiment_score
      END
    ) AS baseline_avg_sentiment,
    SUM(
      CASE
        WHEN datetime(n.time_published) >= datetime('now', '-${recentDays} days')
        THEN 1
        ELSE 0
      END
    ) AS recent_mentions,
    SUM(
      CASE
        WHEN datetime(n.time_published) < datetime('now', '-${recentDays} days')
          AND datetime(n.time_published) >= datetime('now', '-${recentDays + baselineDays} days')
        THEN 1
        ELSE 0
      END
    ) AS baseline_mentions
  FROM ticker_sentiment ts
  JOIN news_items n ON n.id = ts.news_id
  GROUP BY ts.ticker
),
scored AS (
  SELECT
    ticker,
    recent_avg_sentiment,
    baseline_avg_sentiment,
    recent_mentions,
    baseline_mentions,
    (recent_avg_sentiment - baseline_avg_sentiment) AS sentiment_delta,
    CASE
      WHEN baseline_avg_sentiment < 0 AND recent_avg_sentiment > 0 THEN 'Bearish->Bullish'
      WHEN baseline_avg_sentiment > 0 AND recent_avg_sentiment < 0 THEN 'Bullish->Bearish'
      WHEN (recent_avg_sentiment - baseline_avg_sentiment) > 0 THEN 'Bullish acceleration'
      WHEN (recent_avg_sentiment - baseline_avg_sentiment) < 0 THEN 'Bearish acceleration'
      ELSE 'No change'
    END AS flip_type
  FROM ticker_window
  WHERE recent_mentions >= ${minTickerMentions}
    AND baseline_mentions >= ${minTickerMentions}
)
SELECT
  ticker,
  ROUND(baseline_avg_sentiment, 4) AS baseline_avg_sentiment,
  ROUND(recent_avg_sentiment, 4) AS recent_avg_sentiment,
  ROUND(sentiment_delta, 4) AS sentiment_delta,
  recent_mentions,
  baseline_mentions,
  flip_type
FROM scored
ORDER BY ABS(sentiment_delta) DESC, recent_mentions DESC, ticker ASC
LIMIT ${topN};
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const breadthRow = db.prepare(breadthSql).get();
  const topicRows = db.prepare(topicsSql).all();
  const tickerFlipRows = db.prepare(tickerFlipsSql).all();

  const totalArticles = breadthRow?.total_articles ?? 0;
  const bullishArticles = breadthRow?.bullish_articles ?? 0;
  const bearishArticles = breadthRow?.bearish_articles ?? 0;
  const medianSentiment = Number((breadthRow?.median_sentiment ?? 0).toFixed(4));

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      recent_days: recentDays,
      baseline_days: baselineDays,
      top_n: topN,
      min_topic_mentions: minTopicMentions,
      min_ticker_mentions: minTickerMentions,
    },
    total_articles: totalArticles,
    "%bullish_articles": toPercent(bullishArticles, totalArticles),
    "%bearish_articles": toPercent(bearishArticles, totalArticles),
    median_sentiment: medianSentiment,
    top_trending_topics: topicRows,
    top_ticker_flips: tickerFlipRows,
  };

  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "news-breadth-market-tone", timestamp);
  const csvPath = path.join(reportDir, "news-breadth-market-tone.csv");
  const jsonPath = path.join(reportDir, "news-breadth-market-tone.json");
  const chartPath = path.join(reportDir, "news-breadth-market-tone.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csvHeader =
    "total_articles,%bullish_articles,%bearish_articles,median_sentiment,top_trending_topics,top_ticker_flips";
  const csvLine = [
    payload.total_articles,
    payload["%bullish_articles"],
    payload["%bearish_articles"],
    payload.median_sentiment,
    escapeCsv(JSON.stringify(payload.top_trending_topics)),
    escapeCsv(JSON.stringify(payload.top_ticker_flips)),
  ].join(",");
  fs.writeFileSync(csvPath, `${csvHeader}\n${csvLine}\n`, "utf8");
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>News Breadth and Market Tone Dashboard</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>News breadth and market tone dashboard</h2>
  <p>Generated at ${payload.generated_at}</p>
  <p>
    Recent window = ${recentDays} days, baseline window = ${baselineDays} days,
    topN = ${topN}.
  </p>
  <div id="breadth-kpis" style="width: 100%; height: 320px;"></div>
  <div id="topic-momentum" style="width: 100%; height: 520px;"></div>
  <div id="ticker-flips" style="width: 100%; height: 520px;"></div>
  <script>
    const payload = ${JSON.stringify(payload)};
    const topics = payload.top_trending_topics;
    const flips = payload.top_ticker_flips;

    Plotly.newPlot("breadth-kpis", [{
      type: "indicator",
      mode: "number",
      value: payload["%bullish_articles"],
      title: { text: "%bullish_articles" },
      domain: { row: 0, column: 0 }
    }, {
      type: "indicator",
      mode: "number",
      value: payload["%bearish_articles"],
      title: { text: "%bearish_articles" },
      domain: { row: 0, column: 1 }
    }, {
      type: "indicator",
      mode: "number",
      value: payload.median_sentiment,
      title: { text: "median_sentiment" },
      domain: { row: 0, column: 2 }
    }], {
      title: "Market breadth KPIs",
      grid: { rows: 1, columns: 3, pattern: "independent" },
      margin: { t: 60, r: 30, b: 20, l: 30 }
    });

    Plotly.newPlot("topic-momentum", [{
      x: topics.map((d) => d.topic),
      y: topics.map((d) => d.momentum_score),
      type: "bar",
      marker: { color: "#1565c0" },
      text: topics.map((d) => "recent=" + d.recent_count + ", baseline=" + d.baseline_count),
      hovertemplate: "%{x}<br>momentum_score=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "top_trending_topics",
      xaxis: { title: "Topic", tickangle: -35, automargin: true },
      yaxis: { title: "Momentum score (recent/day - baseline/day)" },
      margin: { t: 60, r: 20, b: 120, l: 70 }
    });

    Plotly.newPlot("ticker-flips", [{
      x: flips.map((d) => d.ticker),
      y: flips.map((d) => d.sentiment_delta),
      type: "bar",
      marker: {
        color: flips.map((d) => d.sentiment_delta >= 0 ? "#2e7d32" : "#c62828")
      },
      text: flips.map((d) => d.flip_type + ", recent=" + d.recent_avg_sentiment + ", baseline=" + d.baseline_avg_sentiment),
      hovertemplate: "%{x}<br>sentiment_delta=%{y}<br>%{text}<extra></extra>"
    }], {
      title: "top_ticker_flips",
      xaxis: { title: "Ticker", tickangle: -35, automargin: true },
      yaxis: { title: "Recent - baseline avg ticker sentiment" },
      margin: { t: 60, r: 20, b: 120, l: 70 }
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote dashboard CSV to ${csvPath}`);
  console.log(`Wrote dashboard JSON to ${jsonPath}`);
  console.log(`Wrote dashboard chart to ${chartPath}`);
  console.log(
    `Config: recentDays=${recentDays}, baselineDays=${baselineDays}, topN=${topN}, minTopicMentions=${minTopicMentions}, minTickerMentions=${minTickerMentions}`,
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
