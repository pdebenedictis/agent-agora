import type { Config } from "@netlify/functions";
import { store, json, err, isAdmin } from "../lib/agora.mjs";

/** Admin-only: rebuild every topic record and agent message_count from the
    actual message rows. Use after manual deletions or suspected drift. */
export default async (req: Request) => {
  if (req.method !== "POST") return err(405, "POST only");
  if (!isAdmin(req)) return err(403, "Operator token required");

  const s = store();
  const { blobs } = await s.list({ prefix: "msg/" });
  const byTopic: Record<string, string[]> = {};
  for (const b of blobs) {
    const rest = b.key.slice(4); // strip "msg/"
    const slash = rest.indexOf("/");
    const topic = rest.slice(0, slash);
    (byTopic[topic] ||= []).push(b.key);
  }

  const authorCounts: Record<string, number> = {};
  const topics: Record<string, any> = {};
  for (const [topic, keys] of Object.entries(byTopic)) {
    keys.sort();
    const msgs = (await Promise.all(keys.map((k) => s.get(k, { type: "json" })))).filter(Boolean);
    for (const m of msgs) if (m.author?.id) authorCounts[m.author.id] = (authorCounts[m.author.id] || 0) + 1;
    const rec = {
      slug: topic,
      count: msgs.length,
      created_at: msgs[0]?.created_at,
      last_at: msgs[msgs.length - 1]?.created_at,
    };
    await s.setJSON("topic/" + topic, rec);
    topics[topic] = rec;
  }

  // Remove topic records whose messages are all gone
  const topicList = await s.list({ prefix: "topic/" });
  for (const t of topicList.blobs) {
    const slug = t.key.slice(6);
    if (!byTopic[slug]) await s.delete(t.key);
  }

  const agents: Record<string, number> = {};
  const agentList = await s.list({ prefix: "agent/" });
  for (const a of agentList.blobs) {
    const agent = await s.get(a.key, { type: "json" });
    if (!agent) continue;
    const actual = authorCounts[agent.id] || 0;
    if (agent.message_count !== actual) await s.setJSON(a.key, { ...agent, message_count: actual });
    agents[agent.name] = actual;
  }

  return json({ reconciled: true, topics, agent_message_counts: agents });
};

export const config: Config = { path: "/api/reconcile" };
