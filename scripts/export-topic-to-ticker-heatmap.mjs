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
  console.log(`Usage: npm run report:topic-to-ticker-heatmap -- [lookbackDays=14] [topTickers=20] [topTopics=20] [minTopicMentions=2]

Builds a ticker x topic heatmap to show what themes are driving each name.

Arguments:
  lookbackDays       Recent window size in days (default: 14)
  topTickers         Max unique tickers to include by mention volume (default: 20)
  topTopics          Max unique topics to include by mention volume (default: 20)
  minTopicMentions   Minimum mentions required per ticker/topic pair (default: 2)

Core fields:
  ticker
  topic
  topic_relevance_avg
  topic_sentiment_avg
  topic_mention_count

Output:
  data/reports/topic-to-ticker-heatmap/<UTC_TIMESTAMP>/topic-to-ticker-heatmap.csv
  data/reports/topic-to-ticker-heatmap/<UTC_TIMESTAMP>/topic-to-ticker-heatmap.json
  data/reports/topic-to-ticker-heatmap/<UTC_TIMESTAMP>/topic-to-ticker-heatmap.html

Examples:
  npm run report:topic-to-ticker-heatmap
  npm run report:topic-to-ticker-heatmap -- 10 25 30 3

Options:
  --no-serve    Generate report files without starting web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const positionals = args.filter((arg) => arg !== "--no-serve");
const lookbackDays = Number.parseInt(positionals[0] ?? "14", 10);
const topTickers = Number.parseInt(positionals[1] ?? "20", 10);
const topTopics = Number.parseInt(positionals[2] ?? "20", 10);
const minTopicMentions = Number.parseInt(positionals[3] ?? "2", 10);

if (
  !Number.isInteger(lookbackDays) ||
  !Number.isInteger(topTickers) ||
  !Number.isInteger(topTopics) ||
  !Number.isInteger(minTopicMentions) ||
  lookbackDays <= 0 ||
  topTickers <= 0 ||
  topTopics <= 0 ||
  minTopicMentions <= 0
) {
  console.error(
    "Usage: npm run report:topic-to-ticker-heatmap -- [lookbackDays=14] [topTickers=20] [topTopics=20] [minTopicMentions=2]",
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
    nt.topic AS topic,
    CAST(nt.relevance_score AS REAL) AS topic_relevance,
    ts.ticker_sentiment_score AS ticker_sentiment_score
  FROM ticker_sentiment ts
  JOIN news_topics nt ON nt.news_id = ts.news_id
  JOIN news_items n ON n.id = ts.news_id
  WHERE datetime(n.time_published) >= datetime('now', '-${lookbackDays} days')
),
pair_rollup AS (
  SELECT
    ticker,
    topic,
    AVG(topic_relevance) AS topic_relevance_avg,
    AVG(ticker_sentiment_score) AS topic_sentiment_avg,
    COUNT(*) AS topic_mention_count
  FROM scoped
  GROUP BY ticker, topic
  HAVING COUNT(*) >= ${minTopicMentions}
),
top_tickers AS (
  SELECT ticker
  FROM pair_rollup
  GROUP BY ticker
  ORDER BY SUM(topic_mention_count) DESC, ticker ASC
  LIMIT ${topTickers}
),
top_topics AS (
  SELECT topic
  FROM pair_rollup
  GROUP BY topic
  ORDER BY SUM(topic_mention_count) DESC, topic ASC
  LIMIT ${topTopics}
)
SELECT
  pr.ticker,
  pr.topic,
  ROUND(pr.topic_relevance_avg, 4) AS topic_relevance_avg,
  ROUND(pr.topic_sentiment_avg, 4) AS topic_sentiment_avg,
  pr.topic_mention_count
FROM pair_rollup pr
JOIN top_tickers tt ON tt.ticker = pr.ticker
JOIN top_topics tp ON tp.topic = pr.topic
ORDER BY pr.topic_mention_count DESC, pr.ticker ASC, pr.topic ASC;
`;

try {
  if (configuredDatabasePath !== databasePath) {
    console.log(`Configured SQLITE_PATH not found, using local fallback: ${databasePath}`);
  }

  const rows = db.prepare(sql).all();

  const timestamp = buildTimestampUtc();
  const reportDir = path.resolve(projectRoot, "data", "reports", "topic-to-ticker-heatmap", timestamp);
  const csvPath = path.join(reportDir, "topic-to-ticker-heatmap.csv");
  const jsonPath = path.join(reportDir, "topic-to-ticker-heatmap.json");
  const chartPath = path.join(reportDir, "topic-to-ticker-heatmap.html");
  fs.mkdirSync(reportDir, { recursive: true });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const header = "ticker,topic,topic_relevance_avg,topic_sentiment_avg,topic_mention_count";
  const lines = rows.map(
    (row) =>
      `${escapeCsv(row.ticker)},${escapeCsv(row.topic)},${row.topic_relevance_avg},${row.topic_sentiment_avg},${row.topic_mention_count}`,
  );
  fs.writeFileSync(csvPath, `${header}\n${lines.join("\n")}\n`, "utf8");

  const payload = {
    generated_at: new Date().toISOString(),
    config: {
      lookback_days: lookbackDays,
      top_tickers: topTickers,
      top_topics: topTopics,
      min_topic_mentions: minTopicMentions,
    },
    row_count: rows.length,
    rows,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const chartHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Topic-to-Ticker Heatmap</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
</head>
<body>
  <h2>Topic-to-ticker heatmap</h2>
  <p>Generated at ${payload.generated_at}</p>
  <p>lookbackDays=${lookbackDays}, topTickers=${topTickers}, topTopics=${topTopics}, minTopicMentions=${minTopicMentions}</p>
  <div id="topic-sentiment-heatmap" style="width: 100%; height: 700px;"></div>
  <div id="mention-table" style="width: 100%; height: 720px;"></div>
  <script>
    const rows = ${JSON.stringify(rows)};
    const tickers = Array.from(new Set(rows.map((r) => r.ticker))).sort();
    const topics = Array.from(new Set(rows.map((r) => r.topic))).sort();

    const byPair = new Map(rows.map((r) => [r.ticker + "||" + r.topic, r]));
    const z = topics.map((topic) =>
      tickers.map((ticker) => {
        const row = byPair.get(ticker + "||" + topic);
        return row ? row.topic_sentiment_avg : null;
      }),
    );
    const mentionText = topics.map((topic) =>
      tickers.map((ticker) => {
        const row = byPair.get(ticker + "||" + topic);
        if (!row) return "";
        return "mentions=" + row.topic_mention_count + ", relevance=" + row.topic_relevance_avg;
      }),
    );

    Plotly.newPlot("topic-sentiment-heatmap", [{
      type: "heatmap",
      x: tickers,
      y: topics,
      z,
      zmid: 0,
      colorscale: "RdBu",
      reversescale: true,
      text: mentionText,
      hovertemplate: "Ticker=%{x}<br>Topic=%{y}<br>topic_sentiment_avg=%{z}<br>%{text}<extra></extra>"
    }], {
      title: "Topic sentiment by ticker (color) with mention/relevance context",
      xaxis: {
        title: "Ticker",
        tickmode: "array",
        tickvals: tickers,
        ticktext: tickers,
        tickangle: -50,
        automargin: true,
      },
      yaxis: {
        title: "Topic",
        tickmode: "array",
        tickvals: topics,
        ticktext: topics,
        automargin: true,
      },
      margin: { t: 60, r: 30, b: 180, l: 140 }
    });

    Plotly.newPlot("mention-table", [{
      type: "table",
      header: {
        values: [
          "<b>Ticker</b>",
          "<b>Topic</b>",
          "<b>topic_relevance_avg</b>",
          "<b>topic_sentiment_avg</b>",
          "<b>topic_mention_count</b>"
        ],
        align: "left"
      },
      cells: {
        values: [
          rows.map((d) => d.ticker),
          rows.map((d) => d.topic),
          rows.map((d) => d.topic_relevance_avg),
          rows.map((d) => d.topic_sentiment_avg),
          rows.map((d) => d.topic_mention_count)
        ],
        align: "left"
      }
    }], {
      title: "Topic-to-ticker heatmap rows"
    });
  </script>
</body>
</html>
`;
  fs.writeFileSync(chartPath, chartHtml, "utf8");

  console.log(`Wrote ${rows.length} heatmap rows to ${csvPath}`);
  console.log(`Wrote heatmap JSON to ${jsonPath}`);
  console.log(`Wrote chart to ${chartPath}`);
  console.log(
    `Config: lookbackDays=${lookbackDays}, topTickers=${topTickers}, topTopics=${topTopics}, minTopicMentions=${minTopicMentions}`,
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
