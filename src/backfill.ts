import crypto from "node:crypto";
import path from "node:path";

import { config as loadDotenv } from "dotenv";

import { fetchNewsSentiment, toAlphaVantageTimeParam } from "./alphavantage.js";
import { openDatabase, insertNewsItemIfNew } from "./db.js";
import { toIsoUtc } from "./time.js";

// Load ONLY the backfill-specific env file, so host/container `.env` values
// (like a conservative `ALPHA_VANTAGE_LIMIT`) do not affect the backfill run.
//
// Defaults to `<projectRoot>/.env.backfill`; override with `BACKFILL_ENV_FILE`.
const backfillEnvFile = process.env.BACKFILL_ENV_FILE ?? ".env.backfill";
loadDotenv({
  path: path.resolve(process.cwd(), backfillEnvFile),
});

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

function parseIsoDate(name: string, fallback?: string): Date {
  const raw = env(name, fallback);
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid ISO date for ${name}: ${raw}`);
  return d;
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function secFromIso(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimum ms between request starts; 0 = no limit. */
function parseRequestThrottleMs(): {
  minMsBetweenRequests: number;
  maxRequestsPerMinute: number | null;
} {
  const minRaw = process.env.BACKFILL_MIN_MS_BETWEEN_REQUESTS;
  if (minRaw != null && minRaw !== "") {
    const n = Number(minRaw);
    if (Number.isFinite(n) && n >= 0) {
      return { minMsBetweenRequests: Math.floor(n), maxRequestsPerMinute: null };
    }
  }
  const rpmRaw = process.env.BACKFILL_MAX_REQUESTS_PER_MINUTE ?? "50";
  const rpm = Number(rpmRaw);
  if (!Number.isFinite(rpm) || rpm <= 0) {
    return { minMsBetweenRequests: 0, maxRequestsPerMinute: null };
  }
  const capped = Math.min(Math.max(Math.floor(rpm), 1), 75);
  return {
    minMsBetweenRequests: Math.ceil(60_000 / capped),
    maxRequestsPerMinute: capped,
  };
}

function createRequestThrottle(minMsBetweenRequests: number): () => Promise<void> {
  if (minMsBetweenRequests <= 0) {
    return async () => {};
  }
  let lastStartMs = 0;
  return async () => {
    const now = Date.now();
    const nextSlot = lastStartMs + minMsBetweenRequests;
    if (now < nextSlot) await sleep(nextSlot - now);
    lastStartMs = Date.now();
  };
}

async function fetchItemsWithRetry(params: {
  apiKey: string;
  limit: number;
  time_from: Date;
  time_to: Date;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  throttleRequest: () => Promise<void>;
}): Promise<Awaited<ReturnType<typeof fetchNewsSentiment>>> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= params.maxRetries; attempt++) {
    try {
      await params.throttleRequest();
      return await fetchNewsSentiment({
        apiKey: params.apiKey,
        limit: params.limit,
        time_from: params.time_from,
        time_to: params.time_to,
      });
    } catch (e) {
      lastErr = e;

      // Alpha Vantage “Note”/rate-limit errors are commonly transient.
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = /Alpha Vantage:/i.test(msg) || /Note/i.test(msg);
      if (!retryable || attempt === params.maxRetries) break;

      const backoff = Math.min(
        params.maxDelayMs,
        params.baseDelayMs * Math.pow(2, attempt - 1),
      );
      console.warn(
        `[${new Date().toISOString()}] fetch failed (attempt ${attempt}/${params.maxRetries}); sleeping ${backoff}ms: ${msg}`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function ingestInterval(params: {
  db: ReturnType<typeof openDatabase>;
  runId: string;
  functionName: string;
  apiKey: string;
  limit: number;
  minIntervalSeconds: number;
  lowerBoundMs: number;
  upperBoundMs: number;
  startIso: string;
  endIso: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  throttleRequest: () => Promise<void>;
}): Promise<void> {
  const {
    db,
    runId,
    functionName,
    apiKey,
    limit,
    minIntervalSeconds,
    lowerBoundMs,
    upperBoundMs,
    startIso,
    endIso,
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    throttleRequest,
  } = params;

  const getStatusStmt = db.prepare(
    `SELECT status, last_result_count, error
     FROM backfill_intervals
     WHERE run_id = ? AND function_name = ? AND start_time = ? AND end_time = ?
    `,
  );
  const row = getStatusStmt.get(runId, functionName, startIso, endIso) as
    | { status: string; last_result_count: number | null; error: string | null }
    | undefined;
  if (!row) {
    // Shouldn't happen if seeding is correct; treat as a pending interval.
    const ins = db.prepare(
      `INSERT OR IGNORE INTO backfill_intervals
       (run_id, function_name, start_time, end_time, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    ins.run(runId, functionName, startIso, endIso);
    return ingestInterval(params);
  }
  if (row.status === "done") return;
  if (row.status === "error") throw new Error(`Interval is in error state: ${row.error}`);

  const updateInProgress = db.prepare(
    `UPDATE backfill_intervals
     SET status = 'in_progress', started_at = ?, error = NULL
     WHERE run_id = ? AND function_name = ? AND start_time = ? AND end_time = ?`,
  );
  updateInProgress.run(toIsoUtc(new Date()), runId, functionName, startIso, endIso);

  const startSec = secFromIso(startIso);
  const endSec = secFromIso(endIso);
  const intervalSeconds = endSec - startSec + 1;

  console.log(
    `[${new Date().toISOString()}] interval start: [${startIso} .. ${endIso}] (${intervalSeconds}s)`,
  );

  // Fetch the feed first; we only insert once we decide the interval is “complete”.
  let items = await fetchItemsWithRetry({
    apiKey,
    limit,
    time_from: new Date(startSec * 1000),
    time_to: new Date(endSec * 1000),
    maxRetries,
    baseDelayMs,
    maxDelayMs,
    throttleRequest,
  });

  const apiFrom = toAlphaVantageTimeParam(new Date(startSec * 1000));
  const apiTo = toAlphaVantageTimeParam(new Date(endSec * 1000));
  const sameApiMinute = apiFrom === apiTo;

  if (items.length === limit && sameApiMinute) {
    console.warn(
      `[${new Date().toISOString()}] minute-saturated API window ${apiFrom}: got ${limit} rows (time_from/time_to are minute-precision); storing without further subdivision — some articles may be omitted by Alpha Vantage cap`,
    );
  }

  // Split only when we can still narrow by sub-minute time; same API minute always commits what we fetched.
  if (items.length === limit && !sameApiMinute) {
    if (intervalSeconds <= minIntervalSeconds) {
      const markError = db.prepare(
        `UPDATE backfill_intervals
         SET status = 'error', finished_at = ?, last_result_count = ?, error = ?
         WHERE run_id = ? AND function_name = ? AND start_time = ? AND end_time = ?`,
      );
      markError.run(
        toIsoUtc(new Date()),
        items.length,
        `completeness: interval hit ALPHA_VANTAGE_LIMIT (${limit}) at min resolution (${intervalSeconds}s). Increase ALPHA_VANTAGE_LIMIT (up to 1000) and restart.`,
        runId,
        functionName,
        startIso,
        endIso,
      );
      throw new Error(
        `completeness: interval hit ALPHA_VANTAGE_LIMIT (${limit}) at min resolution (${intervalSeconds}s). Increase ALPHA_VANTAGE_LIMIT (up to 1000) and restart.`,
      );
    }

    // Split into smaller intervals and process children. We avoid overlap when intervalSeconds==2
    // (so progress always advances), otherwise we overlap at mid second to reduce “boundary gaps”.
    const midSec = Math.floor((startSec + endSec) / 2);

    const childSpecs =
      intervalSeconds === 2
        ? [
            { s: startSec, e: startSec },
            { s: startSec + 1, e: endSec },
          ]
        : [
            { s: startSec, e: midSec },
            { s: midSec, e: endSec },
          ];

    const insertChild = db.prepare(
      `INSERT OR IGNORE INTO backfill_intervals
       (run_id, function_name, start_time, end_time, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );

    for (const c of childSpecs) {
      const cs = isoFromSec(c.s);
      const ce = isoFromSec(c.e);
      insertChild.run(runId, functionName, cs, ce);
    }

    for (const c of childSpecs) {
      const cs = isoFromSec(c.s);
      const ce = isoFromSec(c.e);
      await ingestInterval({
        ...params,
        startIso: cs,
        endIso: ce,
      });
    }

    const markDone = db.prepare(
      `UPDATE backfill_intervals
       SET status = 'done', finished_at = ?, last_result_count = ?
       WHERE run_id = ? AND function_name = ? AND start_time = ? AND end_time = ?`,
    );
    markDone.run(toIsoUtc(new Date()), null, runId, functionName, startIso, endIso);
    return;
  }

  let added = 0;
  const itemsInRange = items.filter((item) => {
    const t = item.time_published.getTime();
    return t >= lowerBoundMs && t <= upperBoundMs;
  });

  for (const item of itemsInRange) {
    if (insertNewsItemIfNew(db, item)) added += 1;
  }

  const markDone = db.prepare(
    `UPDATE backfill_intervals
     SET status = 'done', finished_at = ?, last_result_count = ?
     WHERE run_id = ? AND function_name = ? AND start_time = ? AND end_time = ?`,
  );
  markDone.run(
    toIsoUtc(new Date()),
    itemsInRange.length,
    runId,
    functionName,
    startIso,
    endIso,
  );

  console.log(
    `[${new Date().toISOString()}] interval done: [${startIso} .. ${endIso}] fetched=${items.length} inRange=${itemsInRange.length} added=${added}`,
  );
}

async function main(): Promise<void> {
  const apiKey = env("ALPHA_VANTAGE_API_KEY");
  const dbPath = env("SQLITE_PATH", "./data/news.db");
  const limit = parseLimit();

  const lowerBound = parseIsoDate(
    "BACKFILL_LOWER_BOUND",
    "2025-01-01T00:00:00.000Z",
  );
  const upperBound = parseIsoDate(
    "BACKFILL_UPPER_BOUND",
    "2026-03-25T20:09:13.000Z",
  );

  if (upperBound.getTime() < lowerBound.getTime()) {
    throw new Error("BACKFILL_UPPER_BOUND must be >= BACKFILL_LOWER_BOUND");
  }

  const chunkSeconds = clampInt(
    Number(process.env.BACKFILL_CHUNK_SECONDS ?? "86400"),
    2,
    30 * 86400,
    86400,
  );
  const overlapSeconds = clampInt(
    Number(process.env.BACKFILL_OVERLAP_SECONDS ?? "1"),
    0,
    chunkSeconds - 1,
    1,
  );
  const minIntervalSeconds = clampInt(
    Number(process.env.BACKFILL_MIN_INTERVAL_SECONDS ?? "1"),
    1,
    3600 * 24,
    1,
  );

  const maxRetries = clampInt(Number(process.env.BACKFILL_MAX_RETRIES ?? "5"), 0, 50, 5);
  const baseDelayMs = clampInt(
    Number(process.env.BACKFILL_RETRY_BASE_DELAY_MS ?? "5000"),
    0,
    600000,
    5000,
  );
  const maxDelayMs = clampInt(
    Number(process.env.BACKFILL_RETRY_MAX_DELAY_MS ?? "60000"),
    0,
    600000,
    60000,
  );

  const betweenIntervalsDelayMs = clampInt(
    Number(process.env.BACKFILL_BETWEEN_INTERVALS_DELAY_MS ?? "0"),
    0,
    60000,
    0,
  );

  const throttleParsed = parseRequestThrottleMs();
  const throttleRequest = createRequestThrottle(throttleParsed.minMsBetweenRequests);

  const runId = sha256Hex(
    [
      "NEWS_SENTIMENT",
      lowerBound.toISOString(),
      upperBound.toISOString(),
      String(limit),
      String(minIntervalSeconds),
      String(chunkSeconds),
      String(overlapSeconds),
    ].join("|"),
  );

  const functionName = "NEWS_SENTIMENT";
  const lowerBoundMs = lowerBound.getTime();
  const upperBoundMs = upperBound.getTime();

  const throttleDesc =
    throttleParsed.minMsBetweenRequests <= 0
      ? "rateLimit=off"
      : throttleParsed.maxRequestsPerMinute != null
        ? `max ~${throttleParsed.maxRequestsPerMinute} req/min (${throttleParsed.minMsBetweenRequests}ms between requests)`
        : `min ${throttleParsed.minMsBetweenRequests}ms between requests`;
  console.log(
    `[${new Date().toISOString()}] backfill run start: runId=${runId} bounds=[${lowerBound.toISOString()}..${upperBound.toISOString()}] limit=${limit} minIntervalSeconds=${minIntervalSeconds} chunkSeconds=${chunkSeconds} overlapSeconds=${overlapSeconds} betweenIntervalsDelayMs=${betweenIntervalsDelayMs} ${throttleDesc}`,
  );

  const db = openDatabase(dbPath);
  try {
    const upsertRun = db.prepare(
      `INSERT OR IGNORE INTO backfill_runs
       (run_id, function_name, lower_bound, upper_bound, alpha_vantage_limit, min_interval_seconds, chunk_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    upsertRun.run(
      runId,
      functionName,
      lowerBound.toISOString(),
      upperBound.toISOString(),
      limit,
      minIntervalSeconds,
      chunkSeconds,
    );

    // Reset in-progress intervals from a previous run.
    db.prepare(
      `UPDATE backfill_intervals
       SET status = 'pending', started_at = NULL, error = NULL
       WHERE run_id = ? AND function_name = ? AND status = 'in_progress'`,
    ).run(runId, functionName);

    // If any interval failed due to completeness, stop immediately (it's not resumable without changing params).
    const errors = db
      .prepare(
        `SELECT error, start_time, end_time
         FROM backfill_intervals
         WHERE run_id = ? AND function_name = ? AND status = 'error'
        `,
      )
      .all(runId, functionName) as Array<{ error: string; start_time: string; end_time: string }>;
    const completeness = errors.find((e) => e.error?.startsWith("completeness:"));
    if (completeness) {
      throw new Error(
        `Backfill cannot guarantee completeness. First completeness error at [${completeness.start_time} .. ${completeness.end_time}]: ${completeness.error}`,
      );
    }

    // For transient errors, allow retry on next run.
    db.prepare(
      `UPDATE backfill_intervals
       SET status = 'pending', started_at = NULL, error = NULL
       WHERE run_id = ? AND function_name = ? AND status = 'error'`,
    ).run(runId, functionName);

    // Seed chunk intervals (with 1s overlap by default to avoid boundary gaps).
    const lowerSec = Math.floor(lowerBound.getTime() / 1000);
    const upperSec = Math.floor(upperBound.getTime() / 1000);
    if (chunkSeconds <= overlapSeconds) {
      throw new Error("BACKFILL_CHUNK_SECONDS must be > BACKFILL_OVERLAP_SECONDS");
    }

    const insertInterval = db.prepare(
      `INSERT OR IGNORE INTO backfill_intervals
       (run_id, function_name, start_time, end_time, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );

    let secCursor = lowerSec;
    while (secCursor <= upperSec) {
      const endSec = Math.min(secCursor + chunkSeconds - 1, upperSec);
      insertInterval.run(runId, functionName, isoFromSec(secCursor), isoFromSec(endSec));
      if (endSec === upperSec) break;
    // Overlap: the next chunk starts so that exactly `overlapSeconds` seconds are shared
    // between the previous chunk and the next chunk (inclusive endpoints).
    // overlapSeconds=0 => disjoint [a..b] then [b+1..]
    // overlapSeconds=1 => share only second b, next starts at b
    secCursor = endSec - overlapSeconds + 1;
    }

    const selectNext = db.prepare(
      `SELECT start_time, end_time
       FROM backfill_intervals
       WHERE run_id = ? AND function_name = ? AND status = 'pending'
       ORDER BY end_time DESC
       LIMIT 1`,
    );

    const totalPending = () =>
      (db.prepare(
        `SELECT COUNT(*) as n
         FROM backfill_intervals
         WHERE run_id = ? AND function_name = ? AND status = 'pending'`,
      ).get(runId, functionName) as { n: number }).n;

    while (true) {
      const next = selectNext.get(runId, functionName) as
        | { start_time: string; end_time: string }
        | undefined;
      if (!next) break;
      const pending = totalPending();
      console.log(
        `[${new Date().toISOString()}] pending intervals remaining: ${pending}`,
      );

      await ingestInterval({
        db,
        runId,
        functionName,
        apiKey,
        limit,
        minIntervalSeconds,
        lowerBoundMs,
        upperBoundMs,
        startIso: next.start_time,
        endIso: next.end_time,
        maxRetries,
        baseDelayMs,
        maxDelayMs,
        throttleRequest,
      });

      if (betweenIntervalsDelayMs > 0) {
        await sleep(betweenIntervalsDelayMs);
      }
    }

    db.prepare(
      `UPDATE backfill_runs
       SET completed_at = ?
       WHERE run_id = ?`,
    ).run(toIsoUtc(new Date()), runId);

    console.log(`[${new Date().toISOString()}] backfill run complete: runId=${runId}`);
  } finally {
    db.close();
  }
}

await main();

