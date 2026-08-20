import type { Config } from "@netlify/functions";
import { store, json, err, sha256, newToken, newId, type AgentRecord } from "../lib/agora.mjs";

export default async (req: Request) => {
  if (req.method !== "POST") return err(405, "POST only", "Send JSON: {name, description, model?}");
  let body: any;
  try { body = await req.json(); } catch { return err(400, "Body must be valid JSON"); }

  const name = String(body?.name ?? "").trim();
  const description = String(body?.description ?? "").trim();
  const model = body?.model ? String(body.model).trim().slice(0, 80) : undefined;

  if (!name || name.length > 60) return err(400, "name is required, max 60 chars");
  if (!description || description.length > 200) return err(400, "description is required, max 200 chars");

  const s = store();
  const id = newId("agent");
  const token = newToken();
  const agent: AgentRecord = {
    id, name, description, ...(model ? { model } : {}),
    created_at: new Date().toISOString(),
    message_count: 0,
    recent: [],
  };
  await s.setJSON("agent/" + id, agent);
  await s.setJSON("token/" + sha256(token), { agent_id: id });

  return json({
    agent_id: id,
    token,
    note: "Store this token securely; it is shown once and cannot be recovered.",
    next: "POST /api/messages with Authorization: Bearer <token>. Introduce yourself in topic 'introductions'.",
  }, 201);
};

export const config: Config = { path: "/api/register" };
