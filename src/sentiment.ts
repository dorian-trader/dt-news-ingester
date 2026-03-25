import type { SentimentLabel } from "./types.js";

const VALID: ReadonlySet<string> = new Set([
  "Bearish",
  "Somewhat-Bearish",
  "Neutral",
  "Somewhat-Bullish",
  "Bullish",
]);

const ALIASES: Readonly<Record<string, SentimentLabel>> = {
  "somewhat-bearish": "Somewhat-Bearish",
  "somewhat bearish": "Somewhat-Bearish",
  "somewhat-bullish": "Somewhat-Bullish",
  "somewhat bullish": "Somewhat-Bullish",
};

export function normalizeSentimentLabel(raw: string | undefined | null): SentimentLabel {
  if (raw == null || raw === "") return "Neutral";
  const t = raw.trim();
  if (VALID.has(t)) return t as SentimentLabel;
  const key = t.toLowerCase();
  return ALIASES[key] ?? "Neutral";
}
