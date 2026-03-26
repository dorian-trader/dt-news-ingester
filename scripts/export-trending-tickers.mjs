import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

const recentDays = Number.parseInt(process.argv[2] ?? "7", 10);
const baselineDays = Number.parseInt(process.argv[3] ?? "28", 10);
const topN = Number.parseInt(process.argv[4] ?? "10", 10);
const minRecentMentions = Number.parseInt(process.argv[5] ?? "5", 10);

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

  const outputPath = path.resolve(projectRoot, "data", "reports", "trending-tickers.csv");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const header =
    "ticker,recent_count,baseline_count,recent_per_day,baseline_per_day,momentum_score,momentum_ratio";
  const lines = rows.map(
    (row) =>
      `${row.ticker},${row.recent_count},${row.baseline_count},${row.recent_per_day},${row.baseline_per_day},${row.momentum_score},${row.momentum_ratio}`,
  );

  fs.writeFileSync(outputPath, `${header}\n${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${rows.length} trending tickers to ${outputPath}`);
  console.log(
    `Config: recentDays=${recentDays}, baselineDays=${baselineDays}, topN=${topN}, minRecentMentions=${minRecentMentions}`,
  );
} finally {
  db.close();
}
