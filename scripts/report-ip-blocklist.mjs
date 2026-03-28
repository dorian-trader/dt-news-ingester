import fs from "node:fs";
import path from "node:path";

/** Loopback — never ban (local browsing / mis-forwarded proxy during dev). */
function isExemptIp(ip) {
  if (!ip || ip === "unknown") return true;
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  return false;
}

/**
 * Instant ban: path contains .php, .env, or .aws (raw or decoded).
 * Matches encoded probe paths like %2ephp when decoded.
 */
export function pathTriggersInstantProbeBan(url) {
  const pathPart = (url ?? "/").split("?")[0] || "/";
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // malformed; still scan raw
  }
  const a = pathPart.toLowerCase();
  const b = decoded.toLowerCase();
  for (const h of [a, b]) {
    if (h.includes(".php")) return "probe:.php";
    if (h.includes(".env")) return "probe:.env";
    if (h.includes(".aws")) return "probe:.aws";
  }
  return null;
}

/**
 * @param {object} options
 * @param {string} options.stateFilePath - e.g. .../data/reports/.report-ip-blocklist.json
 * @param {number} [options.max404InWindow=50]
 * @param {number} [options.windowMs=600000] - 10 minutes
 * @param {number} [options.banMs404=86400000] - 24h after too many 404s
 * @param {number} [options.banMsInstant=2592000000] - 30d for probe paths
 */
export function createReportIpBlocklist(options) {
  const stateFilePath = options.stateFilePath;
  const max404InWindow = options.max404InWindow ?? 50;
  const windowMs = options.windowMs ?? 10 * 60 * 1000;
  const banMs404 = options.banMs404 ?? 24 * 60 * 60 * 1000;
  const banMsInstant = options.banMsInstant ?? 30 * 24 * 60 * 60 * 1000;

  /** @type {{ bans: Record<string, { until: number, reason: string }>, counters: Record<string, { n: number, since: number }> }} */
  let state = { bans: {}, counters: {} };
  let saveTimer = null;
  let loaded = false;

  function pruneExpiredBans() {
    const now = Date.now();
    for (const ip of Object.keys(state.bans)) {
      if (state.bans[ip].until <= now) {
        delete state.bans[ip];
      }
    }
  }

  function load() {
    if (loaded) return;
    loaded = true;
    try {
      if (fs.existsSync(stateFilePath)) {
        const raw = fs.readFileSync(stateFilePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.bans === "object" && typeof parsed.counters === "object") {
          state = {
            bans: parsed.bans ?? {},
            counters: parsed.counters ?? {},
          };
        }
      }
    } catch {
      state = { bans: {}, counters: {} };
    }
    pruneExpiredBans();
  }

  function flushSave() {
    pruneExpiredBans();
    const dir = path.dirname(stateFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${stateFilePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { version: 1, bans: state.bans, counters: state.counters },
      null,
      2,
    );
    fs.writeFileSync(tmp, `${payload}\n`, "utf8");
    fs.renameSync(tmp, stateFilePath);
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        flushSave();
      } catch {
        // ignore disk errors; server still runs
      }
    }, 300);
  }

  function banIp(ip, reason, durationMs) {
    const until = Date.now() + durationMs;
    state.bans[ip] = { until, reason };
    scheduleSave();
  }

  /**
   * Call at the start of each request. Returns whether to reject with 403.
   * Applies instant probe bans and checks existing ban entries.
   */
  function evaluateRequest(ip, url) {
    load();
    pruneExpiredBans();
    if (isExemptIp(ip)) {
      return { blocked: false };
    }
    const existing = state.bans[ip];
    if (existing && existing.until > Date.now()) {
      return { blocked: true, reason: existing.reason };
    }

    const probe = pathTriggersInstantProbeBan(url);
    if (probe) {
      banIp(ip, probe, banMsInstant);
      return { blocked: true, reason: probe };
    }

    return { blocked: false };
  }

  /**
   * Call when a response has finished with status 404.
   */
  function record404(ip) {
    load();
    pruneExpiredBans();
    if (isExemptIp(ip)) return;

    const now = Date.now();
    let c = state.counters[ip];
    if (!c || now - c.since > windowMs) {
      c = { n: 0, since: now };
      state.counters[ip] = c;
    }
    c.n += 1;
    scheduleSave();

    if (c.n >= max404InWindow) {
      banIp(ip, `404-flood:${c.n}-in-window`, banMs404);
      delete state.counters[ip];
      scheduleSave();
    }
  }

  return {
    evaluateRequest,
    record404,
    /** For tests / debugging */
    _getStatePath: () => stateFilePath,
  };
}
