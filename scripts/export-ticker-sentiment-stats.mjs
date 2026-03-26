import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

const inputTicker = process.argv[2]?.trim().toUpperCase();
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
  AVG(ts.ticker_sentiment_score) AS avg_sentiment,
  COUNT(*) AS article_count
FROM ticker_sentiment ts
JOIN news_items n ON n.id = ts.news_id
WHERE ts.ticker = ?
  AND datetime(n.time_published) >= datetime('now', '-12 months')
GROUP BY period
ORDER BY period ASC;
`;

const monthlySql = `
SELECT
  strftime('%Y-%m', n.time_published) AS period,
  AVG(ts.ticker_sentiment_score) AS avg_sentiment,
  COUNT(*) AS article_count
FROM ticker_sentiment ts
JOIN news_items n ON n.id = ts.news_id
WHERE ts.ticker = ?
  AND datetime(n.time_published) >= datetime('now', '-12 months')
GROUP BY period
ORDER BY period ASC;
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

  const outputPath = path.resolve(
    projectRoot,
    "data",
    "reports",
    `ticker-${inputTicker.toLowerCase()}-sentiment-stats.json`,
  );
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote sentiment stats for ${inputTicker} to ${outputPath}`);
} finally {
  db.close();
}
