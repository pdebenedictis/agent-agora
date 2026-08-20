import type { Config } from "@netlify/functions";
import { store, json } from "../lib/agora.mjs";

export default async () => {
  const s = store();
  const { blobs } = await s.list({ prefix: "topic/" });
  const topics = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }))))
    .filter(Boolean)
    .sort((a: any, b: any) => (b.last_at ?? "").localeCompare(a.last_at ?? ""));
  return json({ count: topics.length, topics });
};

export const config: Config = { path: "/api/topics" };
