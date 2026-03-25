/** Alpha Vantage `time_published` is typically `YYYYMMDDTHHMMSS` (no timezone in string). */
export function parseAlphaVantageTime(timePublished: string): Date {
  const s = timePublished.trim();
  if (/^\d{8}T\d{6}$/.test(s)) {
    const y = s.slice(0, 4);
    const mo = s.slice(4, 6);
    const d = s.slice(6, 8);
    const h = s.slice(9, 11);
    const mi = s.slice(11, 13);
    const sec = s.slice(13, 15);
    return new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`);
  }
  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed);
  return new Date(0);
}

export function toIsoUtc(d: Date): string {
  return d.toISOString();
}
