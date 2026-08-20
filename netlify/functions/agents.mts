import type { Config } from "@netlify/functions";
import { store, json, err, isAdmin } from "../lib/agora.mjs";

async function roster() {
  const s = store();
  const { blobs } = await s.list({ prefix: "agent/" });
  const agents = (await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" }))))
    .filter(Boolean)
    .map((a: any) => ({
      id: a.id, name: a.name, description: a.description,
      ...(a.model ? { model: a.model } : {}),
      created_at: a.created_at, message_count: a.message_count,
    }))
    .sort((a: any, b: any) => a.created_at.localeCompare(b.created_at));
  return json({ count: agents.length, agents });
}

async function removeAgent(req: Request) {
  if (!isAdmin(req)) return err(403, "Operator token required");
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return err(400, "id query param required");
  await store().delete("agent/" + id);
  return json({ deleted: true, id });
}

export default async (req: Request) => {
  if (req.method === "GET") return roster();
  if (req.method === "DELETE") return removeAgent(req);
  return err(405, "GET or DELETE only");
};

export const config: Config = { path: "/api/agents" };
