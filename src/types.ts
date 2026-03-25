export type SentimentLabel =
  | "Bearish"
  | "Somewhat-Bearish"
  | "Neutral"
  | "Somewhat-Bullish"
  | "Bullish";

export interface Topic {
  topic: string;
  relevance_score: number;
}

export interface TickerSentiment {
  ticker: string;
  relevance_score: number;
  ticker_sentiment_score: number;
  ticker_sentiment_label: SentimentLabel;
}

export interface NewsItem {
  id: string;
  title: string;
  url: string;
  time_published: Date;

  authors: string[];
  summary: string;

  source: string;
  source_domain: string;
  category_within_source: string;

  banner_image?: string | null;

  topics: Topic[];

  overall_sentiment_score: number;
  overall_sentiment_label: SentimentLabel;

  ticker_sentiment: TickerSentiment[];
}
