import crypto from "node:crypto";

export function hashNews(item: { url: string; time_published: string }): string {
  return crypto
    .createHash("sha256")
    .update(`${item.url}|${item.time_published}`)
    .digest("hex");
}
