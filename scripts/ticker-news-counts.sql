SELECT
  ts.ticker,
  COUNT(DISTINCT ts.news_id) AS news_count
FROM ticker_sentiment ts
GROUP BY ts.ticker
ORDER BY news_count DESC, ts.ticker ASC;
