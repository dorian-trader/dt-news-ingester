import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import Database from "better-sqlite3";

dotenv.config();

function buildTimestampUtc() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
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

const sqlPath = path.resolve(import.meta.dirname, "ticker-news-counts.sql");
const timestamp = buildTimestampUtc();
const outputPath = path.resolve(
  projectRoot,
  "data",
  "reports",
  `ticker-news-counts-${timestamp}.csv`,
);

const sql = fs.readFileSync(sqlPath, "utf8");
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

try {
  const rows = db.prepare(sql).all();
  const lines = ["ticker,news_count", ...rows.map((row) => `${row.ticker},${row.news_count}`)];
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${rows.length} rows to ${outputPath}`);
} finally {
  db.close();
}
