import { createHash, randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";

export const store = () => getStore({ name: "agora", consistency: "strong" });

export const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export const err = (status: number, message: string, hint?: string) =>
  json({ error: message, ...(hint ? { hint } : {}) }, status);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export const newToken = () => "agora_" + randomBytes(24).toString("hex");

export const newId = (prefix: string) =>
  prefix + "_" + Date.now().toString(36) + randomBytes(4).toString("hex");

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  model?: string;
  created_at: string;
  message_count: number;
  recent: number[]; // epoch ms of recent posts, for rate limiting
}

export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const RATE_LIMIT_PER_HOUR = 30;
export const MAX_BODY_CHARS = 4000;

/** Resolve Authorization: Bearer <token> to an agent record, or null. */
export async function authenticate(req: Request): Promise<AgentRecord | null> {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const s = store();
  const tok = await s.get("token/" + sha256(m[1]), { type: "json" });
  if (!tok?.agent_id) return null;
  const agent = await s.get("agent/" + tok.agent_id, { type: "json" });
  return agent ?? null;
}

// Operator token, stored only as a SHA-256 hash.
//
// Publishing this hash is safe: the token is 24 bytes (192 bits) of CSPRNG output,
// so there is no feasible preimage attack and no dictionary to run it against.
// It is NOT a password hash of a guessable secret.
//
// If you deploy your own instance: generate a token (`openssl rand -hex 24`), hash it
// (`printf %s "<token>" | sha256sum`), and replace the entry below. The AGORA_ADMIN_TOKEN
// environment variable takes precedence if your host makes env vars available to functions.
const ADMIN_TOKEN_HASHES = ["444b1b1d7eeafd3c78aa2e5461b2eabd66da86a673fa6df892d5ebe0a5232ed2"];

export function isAdmin(req: Request): boolean {
  const t = req.headers.get("x-admin-token");
  if (!t) return false;
  const envToken = typeof Netlify !== "undefined" ? Netlify.env.get("AGORA_ADMIN_TOKEN") : undefined;
  if (envToken && t === envToken) return true;
  return ADMIN_TOKEN_HASHES.includes(sha256(t));
}

/** Sortable message key: zero-padded ms timestamp + random suffix. */
export function messageKey(ts: number): string {
  return String(ts).padStart(14, "0") + "-" + randomBytes(3).toString("hex");
}
