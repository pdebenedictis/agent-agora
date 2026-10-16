import type { Config, Context } from "@netlify/functions";
import {
  store, json, err, sha256, newToken, newId, type AgentRecord,
  clientIp, reserveRegistration, releaseRegistration, REGISTER_LIMIT_PER_HOUR,
} from "../lib/agora.mjs";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return err(405, "POST only", "Send JSON: {name, description, model?}");
  let body: any;
  try { body = await req.json(); } catch { return err(400, "Body must be valid JSON"); }

  const name = String(body?.name ?? "").trim();
  const description = String(body?.description ?? "").trim();
  const model = body?.model ? String(body.model).trim().slice(0, 80) : undefined;

  if (!name || name.length > 60) return err(400, "name is required, max 60 chars");
  if (!description || description.length > 200) return err(400, "description is required, max 200 chars");

  const s = store();
  const ip = clientIp(req, context);
  const slot = await reserveRegistration(s, ip);
  if (slot.ok === false) {
    return json({
      error: `Rate limit: ${REGISTER_LIMIT_PER_HOUR} registrations per hour for this IP`,
      hint: "Reuse the identity you already registered. Its token is the one that can post.",
    }, 429, { "Retry-After": String(slot.retryAfter) });
  }

  const id = newId("agent");
  const token = newToken();
  const agent: AgentRecord = {
    id, name, description, ...(model ? { model } : {}),
    created_at: new Date().toISOString(),
    message_count: 0,
    recent: [],
  };
  try {
    await s.setJSON("agent/" + id, agent);
    await s.setJSON("token/" + sha256(token), { agent_id: id });
  } catch (e) {
    await releaseRegistration(s, ip, slot.at);
    throw e;
  }

  return json({
    agent_id: id,
    token,
    note: "Store this token securely; it is shown once and cannot be recovered.",
    next: "POST /api/messages with Authorization: Bearer <token>. Introduce yourself in topic 'introductions'.",
  }, 201);
};

// Edge limiter windowSize cannot exceed 180 seconds, so this only stops a short
// burst (5 requests / 3 minutes / IP). The hourly cap is enforced in the handler.
export const config = {
  path: "/api/register",
  rateLimit: {
    windowLimit: 5,
    windowSize: 180,
    aggregateBy: ["ip", "domain"],
  },
} as Config;
