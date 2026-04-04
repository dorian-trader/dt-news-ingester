import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createReportIpBlocklist } from "./report-ip-blocklist.mjs";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

/**
 * decodeURIComponent throws URIError on malformed percent-encoding (common from bots/scanners).
 * Never throw from path parsing — return a result the handler can map to 400.
 */
function resolveRequestPath(rootDir, requestUrl) {
  const rawPath = (requestUrl ?? "/").split("?")[0] || "/";
  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return { kind: "bad-uri" };
  }
  const relativePath = pathname === "/" ? "." : pathname.replace(/^\/+/, "");
  const candidatePath = path.resolve(rootDir, relativePath);
  if (!candidatePath.startsWith(rootDir)) {
    return { kind: "forbidden" };
  }
  return { kind: "ok", filePath: candidatePath };
}

/** Strip common Node / proxy decoration so matching stays simple. */
function normalizedSocketIp(addr) {
  if (addr == null || addr === "") return null;
  let s = String(addr).trim();
  if (s.startsWith("::ffff:")) s = s.slice("::ffff:".length);
  if (s.startsWith("[") && s.includes("]")) s = s.slice(1, s.indexOf("]"));
  return s || null;
}

/**
 * True when the TCP peer is loopback or RFC1918 — i.e. we expect a reverse proxy (NPM, Docker)
 * in front, not a browser connecting straight to Node from the public internet.
 */
function isTrustedProxyPeer(directIp) {
  const ip = normalizedSocketIp(directIp);
  if (!ip) return false;
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const oct2 = Number(m[1]);
    if (oct2 >= 16 && oct2 <= 31) return true;
  }
  return false;
}

function forwardedForHeaderValue(req) {
  const v = req.headers["x-forwarded-for"];
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0) return v.join(", ");
  return "";
}

/**
 * Client IP for logging / blocklist. When trustProxy is true (default unless REPORT_TRUST_PROXY=0):
 * - If the TCP peer looks like a local/Docker proxy, use the rightmost entry of X-Forwarded-For
 *   (nginx appends $remote_addr after any client-spoofed left entries).
 * - Otherwise ignore X-Forwarded-For so random scanners cannot claim 127.0.0.1.
 */
function getClientIp(req) {
  const trustProxy = process.env.REPORT_TRUST_PROXY !== "0";
  const direct = req.socket?.remoteAddress ?? null;
  const xff = forwardedForHeaderValue(req);

  if (trustProxy && xff && isTrustedProxyPeer(direct)) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length > 0) {
      return normalizedSocketIp(parts[parts.length - 1]) ?? parts[parts.length - 1];
    }
  }

  return normalizedSocketIp(direct) ?? direct ?? "unknown";
}

function logRequest(req, statusCode, extra = "") {
  const ts = new Date().toISOString();
  const ip = getClientIp(req);
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const suffix = extra ? ` ${extra}` : "";
  process.stdout.write(`[report-server] [${ts}] ${ip} "${method} ${url}" ${statusCode}${suffix}\n`);
}

export async function startReportServer({
  rootDir,
  reportPath,
  requestedPort,
  requestedHost = "127.0.0.1",
}) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteReportPath = path.resolve(reportPath);
  const relativeReportPath = path.relative(absoluteRoot, absoluteReportPath).replace(/\\/g, "/");
  const host = requestedHost;
  let port = requestedPort;

  const blocklist = createReportIpBlocklist({
    stateFilePath: path.join(absoluteRoot, ".report-ip-blocklist.json"),
  });

  while (true) {
    const server = http.createServer((req, res) => {
      try {
        const ip = getClientIp(req);
        const block = blocklist.evaluateRequest(ip, req.url);
        if (block.blocked) {
          res.statusCode = 403;
          res.end("Forbidden");
          res.once("finish", () =>
            logRequest(req, 403, `(blocked: ${block.reason})`),
          );
          return;
        }

        const resolved = resolveRequestPath(absoluteRoot, req.url);
        if (resolved.kind === "bad-uri") {
          res.statusCode = 400;
          res.end("Bad Request");
          res.once("finish", () => logRequest(req, res.statusCode, "(malformed URI)"));
          return;
        }
        if (resolved.kind === "forbidden") {
          res.statusCode = 403;
          res.end("Forbidden");
          res.once("finish", () => logRequest(req, res.statusCode));
          return;
        }

        let filePath = resolved.filePath;
        if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
          filePath = path.join(filePath, "index.html");
        }

        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          res.statusCode = 404;
          res.end("Not found");
          res.once("finish", () => {
            blocklist.record404(ip);
            logRequest(req, res.statusCode);
          });
          return;
        }

        const relativeFilePath = path.relative(absoluteRoot, filePath).replace(/\\/g, "/");
        res.once("finish", () => logRequest(req, res.statusCode, `-> /${relativeFilePath}`));
        res.statusCode = 200;
        res.setHeader("Content-Type", contentTypeFor(filePath));
        fs.createReadStream(filePath).pipe(res);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
        res.once("finish", () =>
          logRequest(req, res.statusCode, `(handler error: ${message})`),
        );
      }
    });

    const listenResult = await new Promise((resolve) => {
      const onError = (error) => resolve({ ok: false, error });
      server.once("error", onError);
      server.listen(port, host, () => {
        server.off("error", onError);
        resolve({ ok: true, server });
      });
    });

    if (listenResult.ok) {
      const baseUrl = `http://${host}:${port}`;
      const reportUrl = `${baseUrl}/${relativeReportPath}`;
      return { server: listenResult.server, baseUrl, reportUrl, port };
    }

    if (listenResult.error?.code !== "EADDRINUSE") {
      throw listenResult.error;
    }
    port += 1;
  }
}
