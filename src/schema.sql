-- Normalized schema for time-series sentiment, author bias, and ticker drill-downs.
-- Run with foreign_keys enabled.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  time_published TEXT NOT NULL, -- ISO-8601 UTC
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  source_domain TEXT NOT NULL DEFAULT '',
  category_within_source TEXT NOT NULL DEFAULT '',
  banner_image TEXT,
  overall_sentiment_score REAL NOT NULL,
  overall_sentiment_label TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_news_items_time_published ON news_items (time_published);
CREATE INDEX IF NOT EXISTS idx_news_items_overall_label ON news_items (overall_sentiment_label);
CREATE INDEX IF NOT EXISTS idx_news_items_source ON news_items (source);
CREATE INDEX IF NOT EXISTS idx_news_items_source_domain ON news_items (source_domain);
CREATE INDEX IF NOT EXISTS idx_news_items_sentiment_time ON news_items (time_published, overall_sentiment_score);

CREATE TABLE IF NOT EXISTS news_authors (
  news_id TEXT NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  PRIMARY KEY (news_id, author)
);

CREATE INDEX IF NOT EXISTS idx_news_authors_author ON news_authors (author);
CREATE INDEX IF NOT EXISTS idx_news_authors_author_news ON news_authors (author, news_id);

CREATE TABLE IF NOT EXISTS news_topics (
  news_id TEXT NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  PRIMARY KEY (news_id, topic)
);

CREATE INDEX IF NOT EXISTS idx_news_topics_topic ON news_topics (topic);

CREATE TABLE IF NOT EXISTS ticker_sentiment (
  news_id TEXT NOT NULL REFERENCES news_items (id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  relevance_score REAL NOT NULL,
  ticker_sentiment_score REAL NOT NULL,
  ticker_sentiment_label TEXT NOT NULL,
  PRIMARY KEY (news_id, ticker)
);

CREATE INDEX IF NOT EXISTS idx_ticker_sentiment_ticker ON ticker_sentiment (ticker);
CREATE INDEX IF NOT EXISTS idx_ticker_sentiment_ticker_score ON ticker_sentiment (ticker, ticker_sentiment_score);
CREATE INDEX IF NOT EXISTS idx_ticker_sentiment_news ON ticker_sentiment (news_id);
