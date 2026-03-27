import fs from "node:fs";
import path from "node:path";
import { startReportServer } from "./report-server.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sortLatestFirst(values) {
  return [...values].sort((a, b) => b.localeCompare(a));
}

function isTimestampDirName(name) {
  return /^\d{8}T\d{6}Z$/.test(name);
}

function collectLatestReports(reportsRoot) {
  if (!fs.existsSync(reportsRoot)) {
    return [];
  }

  const families = fs
    .readdirSync(reportsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const results = [];
  for (const family of families) {
    const familyDir = path.join(reportsRoot, family);
    const timestamps = sortLatestFirst(
      fs
        .readdirSync(familyDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && isTimestampDirName(entry.name))
        .map((entry) => entry.name),
    );
    const latestTimestamp = timestamps[0];
    if (!latestTimestamp) {
      continue;
    }

    const latestDir = path.join(familyDir, latestTimestamp);
    const files = fs
      .readdirSync(latestDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
    if (files.length === 0) {
      continue;
    }

    const preferredOrder = [".html", ".csv", ".json", ".txt"];
    const primaryFile =
      files.find((fileName) => preferredOrder.includes(path.extname(fileName).toLowerCase())) ?? files[0];

    results.push({
      family,
      latestTimestamp,
      files,
      primaryFile,
    });
  }

  return results;
}

function buildIndexHtml(items) {
  const generatedAt = new Date().toISOString();
  const rows = items
    .map((item) => {
      const family = escapeHtml(item.family);
      const latestTimestamp = escapeHtml(item.latestTimestamp);
      const primaryHref = `./${encodeURIComponent(item.family)}/${encodeURIComponent(item.latestTimestamp)}/${encodeURIComponent(item.primaryFile)}`;
      const fileLinks = item.files
        .map((fileName) => {
          const href = `./${encodeURIComponent(item.family)}/${encodeURIComponent(item.latestTimestamp)}/${encodeURIComponent(fileName)}`;
          return `<a href="${href}">${escapeHtml(fileName)}</a>`;
        })
        .join(" | ");
      return `<tr>
  <td><code>${family}</code></td>
  <td><code>${latestTimestamp}</code></td>
  <td><a href="${primaryHref}"><strong>${escapeHtml(item.primaryFile)}</strong></a></td>
  <td>${fileLinks}</td>
</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Report Index</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: sans-serif; margin: 24px; line-height: 1.45; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px; border-bottom: 1px solid #6664; vertical-align: top; }
    code { font-size: 0.95em; }
  </style>
</head>
<body>
  <h1>Latest report outputs</h1>
  <p>Generated at <code>${escapeHtml(generatedAt)}</code></p>
  ${
    items.length === 0
      ? "<p>No report outputs found. Run one or more report exporters first.</p>"
      : `<table>
  <thead>
    <tr>
      <th>Report family</th>
      <th>Latest timestamp</th>
      <th>Primary file</th>
      <th>All files</th>
    </tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>`
  }
</body>
</html>
`;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: npm run report:all

Generates data/reports/index.html that links to latest output from each report family,
then serves data/reports as a static website.

Options:
  --no-serve    Generate index only, do not start web server
  -h, --help    Show this help message`);
  process.exit(0);
}

const serveEnabled = !args.includes("--no-serve");
const projectRoot = path.resolve(import.meta.dirname, "..");
const reportsRoot = path.resolve(projectRoot, "data", "reports");
const indexPath = path.join(reportsRoot, "index.html");

const latestReports = collectLatestReports(reportsRoot);
fs.mkdirSync(reportsRoot, { recursive: true });
fs.writeFileSync(indexPath, buildIndexHtml(latestReports), "utf8");
console.log(`Wrote report index: ${indexPath}`);
console.log(`Found ${latestReports.length} report families with outputs.`);

if (serveEnabled) {
  const requestedPort = Number.parseInt(process.env.REPORT_PORT ?? "8788", 10);
  const { reportUrl, baseUrl } = await startReportServer({
    rootDir: reportsRoot,
    reportPath: indexPath,
    requestedPort: Number.isInteger(requestedPort) ? requestedPort : 8788,
    requestedHost: "0.0.0.0",
  });
  console.log(`Reports server: ${baseUrl}`);
  console.log(`Open landing page: ${reportUrl}`);
  console.log("Press Ctrl+C to stop.");
}
