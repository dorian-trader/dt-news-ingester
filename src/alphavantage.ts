import { hashNews } from "./hash.js";
import { normalizeSentimentLabel } from "./sentiment.js";
import { parseAlphaVantageTime } from "./time.js";
import type { NewsItem, TickerSentiment, Topic } from "./types.js";

/** NEWS_SENTIMENT `time_from` / `time_to`: `YYYYMMDDTHHMM` (minute precision, UTC). See Alpha Vantage docs. */
export function toAlphaVantageTimeParam(time: Date | string): string {
  if (typeof time === "string") {
    const s = time.trim();
    if (/^\d{8}T\d{4}$/.test(s)) return s;
    // Feed timestamps use second precision; API range params do not.
    if (/^\d{8}T\d{6}$/.test(s)) return s.slice(0, 13);
    const parsed = new Date(s);
    if (!Number.isNaN(parsed.getTime())) {
      return toAlphaVantageTimeParam(parsed);
    }
    return s;
  }

  const y = time.getUTCFullYear().toString().padStart(4, "0");
  const mo = (time.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = time.getUTCDate().toString().padStart(2, "0");
  const h = time.getUTCHours().toString().padStart(2, "0");
  const mi = time.getUTCMinutes().toString().padStart(2, "0");
  return `${y}${mo}${d}T${h}${mi}`;
}

function num(raw: string | number | undefined | null, fallback = 0): number {
  if (raw == null || raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function splitAuthors(raw: unknown): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((a) => (typeof a === "string" ? a.trim() : String(a).trim()))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseTopics(raw: unknown): Topic[] {
  if (!Array.isArray(raw)) return [];
  const out: Topic[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const topic = typeof o.topic === "string" ? o.topic.trim() : "";
    if (!topic) continue;
    const relevance_score = num(o.relevance_score as string | number | undefined);
    out.push({ topic, relevance_score });
  }
  return out;
}

function parseTickerSentiment(raw: unknown): TickerSentiment[] {
  if (!Array.isArray(raw)) return [];
  const out: TickerSentiment[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const tickerRaw = typeof o.ticker === "string" ? o.ticker.trim().toUpperCase() : "";
    if (!tickerRaw) continue;
    out.push({
      ticker: tickerRaw,
      relevance_score: num(o.relevance_score as string | number | undefined),
      ticker_sentiment_score: num(o.ticker_sentiment_score as string | number | undefined),
      ticker_sentiment_label: normalizeSentimentLabel(
        typeof o.ticker_sentiment_label === "string" ? o.ticker_sentiment_label : undefined,
      ),
    });
  }
  return out;
}

export interface AlphaVantageFeedEntry {
  title?: string;
  url?: string;
  time_published?: string;
  authors?: string | string[];
  summary?: string;
  source?: string;
  source_domain?: string;
  category_within_source?: string;
  banner_image?: string;
  topics?: unknown;
  overall_sentiment_score?: string | number;
  overall_sentiment_label?: string;
  ticker_sentiment?: unknown;
}

export interface AlphaVantageNewsResponse {
  feed?: AlphaVantageFeedEntry[];
  items?: string;
  Information?: string;
  Note?: string;
  ["Error Message"]?: string;
}

export function mapFeedEntryToNewsItem(entry: AlphaVantageFeedEntry): NewsItem | null {
  const url = typeof entry.url === "string" ? entry.url.trim() : "";
  const time_published_raw =
    typeof entry.time_published === "string" ? entry.time_published.trim() : "";
  if (!url || !time_published_raw) return null;

  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
  const source = typeof entry.source === "string" ? entry.source.trim() : "";
  const source_domain =
    typeof entry.source_domain === "string" ? entry.source_domain.trim() : "";
  const category_within_source =
    typeof entry.category_within_source === "string"
      ? entry.category_within_source.trim()
      : "";

  const timeDate = parseAlphaVantageTime(time_published_raw);
  const banner =
    typeof entry.banner_image === "string" && entry.banner_image.trim() !== ""
      ? entry.banner_image.trim()
      : null;

  return {
    id: hashNews({ url, time_published: time_published_raw }),
    title,
    url,
    time_published: timeDate,
    authors: splitAuthors(entry.authors),
    summary,
    source,
    source_domain,
    category_within_source,
    banner_image: banner,
    topics: parseTopics(entry.topics),
    overall_sentiment_score: num(entry.overall_sentiment_score),
    overall_sentiment_label: normalizeSentimentLabel(entry.overall_sentiment_label),
    ticker_sentiment: parseTickerSentiment(entry.ticker_sentiment),
  };
}

export async function fetchNewsSentiment(params: {
  apiKey: string;
  limit?: number;
  time_from?: Date | string;
  time_to?: Date | string;
}): Promise<NewsItem[]> {
  const limit = params.limit ?? 50;
  const u = new URL("https://www.alphavantage.co/query");
  u.searchParams.set("function", "NEWS_SENTIMENT");
  u.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 1000)));
  if (params.time_from != null) {
    u.searchParams.set("time_from", toAlphaVantageTimeParam(params.time_from));
  }
  if (params.time_to != null) {
    u.searchParams.set("time_to", toAlphaVantageTimeParam(params.time_to));
  }
  u.searchParams.set("apikey", params.apiKey);

  if (process.env.DEBUG_ALPHA_VANTAGE_REQUEST === "1") {
    const debugUrl = new URL(u.toString());
    if (debugUrl.searchParams.has("apikey")) {
      debugUrl.searchParams.set("apikey", "***");
    }
    console.log(
      `[${new Date().toISOString()}] alphavantage request: ${debugUrl.toString()}`,
    );
  }

  const res = await fetch(u);
  if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
  const body = (await res.json()) as AlphaVantageNewsResponse;

  if (body["Error Message"])
    throw new Error(`Alpha Vantage error: ${body["Error Message"]}`);
  if (body.Information) throw new Error(`Alpha Vantage: ${body.Information}`);
  if (body.Note) throw new Error(`Alpha Vantage: ${body.Note}`);

  const feed = body.feed;
  if (!Array.isArray(feed)) return [];

  const out: NewsItem[] = [];
  for (const entry of feed) {
    const item = mapFeedEntryToNewsItem(entry);
    if (item) out.push(item);
  }
  return out;
}

