import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

import { toIsoUtc } from "./time.js";
import type { NewsItem } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let schemaSql: string | null = null;

function loadSchema(): string {
  if (schemaSql) return schemaSql;
  const p = path.join(__dirname, "schema.sql");
  schemaSql = fs.readFileSync(p, "utf8");
  return schemaSql;
}

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // Long busy timeout: backfill + container can contend on the same file (especially on Windows bind mounts).
  const db = new Database(dbPath, { timeout: 30_000 });
  // WAL tolerates concurrent readers + writer far better than DELETE journaling across two processes.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(loadSchema());
  return db;
}

export function insertNewsItemIfNew(db: Database.Database, item: NewsItem): boolean {
  const timeIso = toIsoUtc(item.time_published);

  const insertNews = db.prepare(`
    INSERT OR IGNORE INTO news_items (
      id, title, url, time_published, summary, source, source_domain,
      category_within_source, banner_image, overall_sentiment_score, overall_sentiment_label
    ) VALUES (
      @id, @title, @url, @time_published, @summary, @source, @source_domain,
      @category_within_source, @banner_image, @overall_sentiment_score, @overall_sentiment_label
    )
  `);

  const insAuthor = db.prepare(
    `INSERT OR IGNORE INTO news_authors (news_id, author) VALUES (?, ?)`,
  );
  const insTopic = db.prepare(
    `INSERT OR IGNORE INTO news_topics (news_id, topic, relevance_score) VALUES (?, ?, ?)`,
  );
  const insTicker = db.prepare(
    `INSERT OR IGNORE INTO ticker_sentiment (
      news_id, ticker, relevance_score, ticker_sentiment_score, ticker_sentiment_label
    ) VALUES (?, ?, ?, ?, ?)`,
  );

  const insertNew = db.transaction(() => {
    const info = insertNews.run({
      id: item.id,
      title: item.title,
      url: item.url,
      time_published: timeIso,
      summary: item.summary,
      source: item.source,
      source_domain: item.source_domain,
      category_within_source: item.category_within_source,
      banner_image: item.banner_image ?? null,
      overall_sentiment_score: item.overall_sentiment_score,
      overall_sentiment_label: item.overall_sentiment_label,
    });
    if (info.changes === 0) return false;

    for (const a of item.authors) insAuthor.run(item.id, a);
    for (const t of item.topics) insTopic.run(item.id, t.topic, t.relevance_score);
    for (const ts of item.ticker_sentiment)
      insTicker.run(
        item.id,
        ts.ticker,
        ts.relevance_score,
        ts.ticker_sentiment_score,
        ts.ticker_sentiment_label,
      );
    return true;
  });

  return insertNew();
}
