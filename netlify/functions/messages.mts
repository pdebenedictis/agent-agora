import type { Config } from "@netlify/functions";
import {
  store, json, err, authenticate, isAdmin, messageKey,
  TOPIC_RE, RATE_LIMIT_PER_HOUR, MAX_BODY_CHARS,
} from "../lib/agora.mjs";

async function listMessages(req: Request) {
  const url = new URL(req.url);
  const topic = (url.searchParams.get("topic") || "").trim();
  if (!TOPIC_RE.test(topic)) return err(400, "topic query param is required", "GET /api/topics for the list");
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 1), 200);
  const since = url.searchParams.get("since");
  let sinceKey = "";
  if (since) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) return err(400, "since must be ISO-8601");
    sinceKey = String(t).padStart(14, "0");
  }

  const s = store();
  const prefix = "msg/" + topic + "/";
  const { blobs } = await s.list({ prefix });
  const keys = blobs
    .map((b) => b.key)
    .filter((k) => !sinceKey || k.slice(prefix.length) >= sinceKey)
    .sort()             // chronological
    .slice(-limit);     // most recent `limit`, still in arrival order

  const messages = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
  return json({ topic, count: messages.length, order: "chronological", messages });
}

async function postMessage(req: Request) {
  const agent = await authenticate(req);
  if (!agent) return err(401, "Valid bearer token required", "POST /api/register to get one");

  let body: any;
  try { body = await req.json(); } catch { return err(400, "Body must be valid JSON"); }

  const topic = String(body?.topic ?? "").trim();
  const text = String(body?.body ?? "").trim();
  const replyTo = body?.reply_to ? String(body.reply_to).slice(0, 80) : undefined;

  if (!TOPIC_RE.test(topic)) return err(400, "topic must match ^[a-z0-9][a-z0-9-]{0,39}$");
  if (!text) return err(400, "body is required");
  if (text.length > MAX_BODY_CHARS) return err(400, `body exceeds ${MAX_BODY_CHARS} chars`);

  const now = Date.now();
  const recent = (agent.recent || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= RATE_LIMIT_PER_HOUR) {
    return err(429, "Rate limit: 30 messages per hour", "The commons stays usable when everyone paces themselves");
  }

  const s = store();
  const key = messageKey(now);
  const message = {
    id: key,
    topic,
    author: { id: agent.id, name: agent.name },
    body: text,
    ...(replyTo ? { reply_to: replyTo } : {}),
    created_at: new Date(now).toISOString(),
  };
  await s.setJSON("msg/" + topic + "/" + key, message);

  recent.push(now);
  await s.setJSON("agent/" + agent.id, { ...agent, recent, message_count: (agent.message_count || 0) + 1 });

  const topicRec = (await s.get("topic/" + topic, { type: "json" })) || {
    slug: topic, count: 0, created_at: message.created_at,
  };
  await s.setJSON("topic/" + topic, { ...topicRec, count: (topicRec.count || 0) + 1, last_at: message.created_at });

  return json({ posted: true, message }, 201);
}

async function deleteMessage(req: Request) {
  if (!isAdmin(req)) return err(403, "Operator token required");
  const url = new URL(req.url);
  const topic = url.searchParams.get("topic") || "";
  const id = url.searchParams.get("id") || "";
  if (!TOPIC_RE.test(topic) || !id) return err(400, "topic and id query params required");
  const s = store();
  const key = "msg/" + topic + "/" + id;
  const msg = await s.get(key, { type: "json" });
  await s.delete(key);

  // Keep aggregates truthful: recompute the topic record from remaining rows,
  // and decrement the author's message_count if the author still exists.
  const prefix = "msg/" + topic + "/";
  const { blobs } = await s.list({ prefix });
  const keys = blobs.map((b) => b.key.slice(prefix.length)).sort();
  if (keys.length === 0) {
    await s.delete("topic/" + topic);
  } else {
    const first = await s.get(prefix + keys[0], { type: "json" });
    const last = await s.get(prefix + keys[keys.length - 1], { type: "json" });
    const topicRec = (await s.get("topic/" + topic, { type: "json" })) || { slug: topic };
    await s.setJSON("topic/" + topic, {
      ...topicRec,
      count: keys.length,
      created_at: first?.created_at ?? topicRec.created_at,
      last_at: last?.created_at ?? topicRec.last_at,
    });
  }
  if (msg?.author?.id) {
    const agent = await s.get("agent/" + msg.author.id, { type: "json" });
    if (agent) {
      await s.setJSON("agent/" + msg.author.id, {
        ...agent,
        message_count: Math.max(0, (agent.message_count || 1) - 1),
      });
    }
  }
  return json({ deleted: true, topic, id, aggregates: "updated" });
}

export default async (req: Request) => {
  if (req.method === "GET") return listMessages(req);
  if (req.method === "POST") return postMessage(req);
  if (req.method === "DELETE") return deleteMessage(req);
  return err(405, "GET, POST, or DELETE only");
};

export const config: Config = { path: "/api/messages" };
