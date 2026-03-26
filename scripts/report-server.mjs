import http from "node:http";
import fs from "node:fs";
import path from "node:path";

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

function resolveRequestPath(rootDir, requestUrl) {
  const pathname = decodeURIComponent((requestUrl ?? "/").split("?")[0] || "/");
  const relativePath = pathname === "/" ? "." : pathname.replace(/^\/+/, "");
  const candidatePath = path.resolve(rootDir, relativePath);
  if (!candidatePath.startsWith(rootDir)) {
    return null;
  }
  return candidatePath;
}

export async function startReportServer({ rootDir, reportPath, requestedPort }) {
  const absoluteRoot = path.resolve(rootDir);
  const absoluteReportPath = path.resolve(reportPath);
  const relativeReportPath = path.relative(absoluteRoot, absoluteReportPath).replace(/\\/g, "/");
  const host = "127.0.0.1";
  let port = requestedPort;

  while (true) {
    const server = http.createServer((req, res) => {
      const resolved = resolveRequestPath(absoluteRoot, req.url);
      if (!resolved) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }

      let filePath = resolved;
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", contentTypeFor(filePath));
      fs.createReadStream(filePath).pipe(res);
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
