import "dotenv/config";

import { fetchNewsSentiment } from "./alphavantage.js";
import { openDatabase, insertNewsItemIfNew } from "./db.js";

const FIVE_MIN_MS = 5 * 60 * 1000;

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v != null && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

function parseLimit(): number {
  const raw = process.env.ALPHA_VANTAGE_LIMIT;
  if (raw == null || raw === "") return 50;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
  return Math.min(Math.max(Math.floor(n), 1), 1000);
}

async function ingestOnce(): Promise<void> {
  const apiKey = env("ALPHA_VANTAGE_API_KEY");
  const dbPath = env("SQLITE_PATH", "./data/news.db");
  const limit = parseLimit();

  const db = openDatabase(dbPath);
  try {
    const items = await fetchNewsSentiment({ apiKey, limit });
    let added = 0;
    for (const item of items) {
      if (insertNewsItemIfNew(db, item)) added += 1;
    }
    console.log(
      `[${new Date().toISOString()}] limit=${limit} (ALPHA_VANTAGE_LIMIT), ` +
        `fetched ${items.length} article(s) in response, inserted ${added} new`,
    );
  } finally {
    db.close();
  }
}

function scheduleLoop(): void {
  const once =
    process.env.INGEST_ONCE === "1" ||
    /^true$/i.test(process.env.INGEST_ONCE ?? "");

  if (once) {
    void ingestOnce()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error(`[${new Date().toISOString()}] ingest failed:`, e);
        process.exit(1);
      });
    return;
  }

  void ingestOnce().catch((e) => {
    console.error(`[${new Date().toISOString()}] ingest failed:`, e);
  });
  setInterval(() => {
    void ingestOnce().catch((err) => {
      console.error(`[${new Date().toISOString()}] ingest failed:`, err);
    });
  }, FIVE_MIN_MS);
}

scheduleLoop();
