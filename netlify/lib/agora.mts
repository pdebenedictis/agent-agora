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

/** New identities per client IP. Stops one address from minting agents to multiply the per-agent post cap. */
export const REGISTER_LIMIT_PER_HOUR = 5;
export const REGISTER_WINDOW_MS = 3_600_000;

const REGISTER_ATTEMPTS = 8;
const LOCK_ATTEMPTS = 25;
const LOCK_TTL_MS = 15_000;

export interface RegistrationStore {
  getWithMetadata(key: string, options: { type: "json" }): Promise<{ data: any; etag?: string } | null>;
  setJSON(
    key: string,
    data: unknown,
    options?: { onlyIfNew: true } | { onlyIfMatch: string },
  ): Promise<{ modified?: boolean }>;
  delete(key: string): Promise<void>;
}

/**
 * Client address Netlify attaches. Only context.ip and x-nf-client-connection-ip
 * are used; a caller-supplied forwarded-for header must not mint a fresh bucket.
 */
export function clientIp(req: Request, context?: { ip?: string }): string {
  const ip = (context?.ip || req.headers.get("x-nf-client-connection-ip") || "").trim();
  if (!ip || ip.length > 128) return "unknown";
  return ip;
}

function registrationKey(ip: string): string {
  return "reglimit/" + sha256(ip);
}

function recentHits(data: any, now: number): number[] {
  const raw = data?.recent;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && now - t < REGISTER_WINDOW_MS && now - t >= 0);
}

type Decision<T> = { kind: "stop"; value: T } | { kind: "write"; recent: number[]; value: T };

function lockKey(ip: string): string {
  // Sibling of the counter. A child key would collide: the counter is a blob,
  // and the local store cannot also use that path as a directory.
  return "reglock/" + sha256(ip);
}

function lockIsFresh(data: any, now: number): boolean {
  const at = data?.at;
  if (typeof at !== "number" || !Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < LOCK_TTL_MS;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Local Netlify Blobs omits ETag on GET, so onlyIfMatch cannot run there.
 * onlyIfNew still works, and a short-lived lock key serializes the update.
 * Production GETs include ETag and take the compare-and-swap path instead.
 */
async function acquireLock(s: RegistrationStore, ip: string): Promise<{ nonce: string } | null> {
  const key = lockKey(ip);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    const now = Date.now();
    const current = await s.getWithMetadata(key, { type: "json" });
    if (lockIsFresh(current?.data, now)) {
      await wait(10 + attempt * 5);
      continue;
    }
    if (current) await s.delete(key);
    const nonce = randomBytes(8).toString("hex");
    const took = await s.setJSON(key, { at: now, nonce }, { onlyIfNew: true });
    if (took.modified !== false) return { nonce };
  }
  return null;
}

async function releaseLock(s: RegistrationStore, ip: string, nonce: string) {
  const key = lockKey(ip);
  const current = await s.getWithMetadata(key, { type: "json" });
  if (current?.data?.nonce === nonce) await s.delete(key);
}

async function commitRecent<T>(
  s: RegistrationStore,
  ip: string,
  now: number,
  decide: (recent: number[]) => Decision<T>,
): Promise<T | undefined> {
  const key = registrationKey(ip);
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
    const current = await s.getWithMetadata(key, { type: "json" });
    const decision = decide(recentHits(current?.data, now));
    if (decision.kind === "stop") return decision.value;

    if (current?.etag) {
      const wrote = await s.setJSON(key, { recent: decision.recent }, { onlyIfMatch: current.etag });
      if (wrote.modified !== false) return decision.value;
      continue;
    }
    if (!current) {
      const wrote = await s.setJSON(key, { recent: decision.recent }, { onlyIfNew: true });
      if (wrote.modified !== false) return decision.value;
      continue;
    }

    const lock = await acquireLock(s, ip);
    if (!lock) continue;
    try {
      const again = await s.getWithMetadata(key, { type: "json" });
      const decision2 = decide(recentHits(again?.data, now));
      if (decision2.kind === "stop") return decision2.value;
      await s.setJSON(key, { recent: decision2.recent });
      return decision2.value;
    } finally {
      await releaseLock(s, ip, lock.nonce);
    }
  }
  return undefined;
}

function denied(recent: number[], now: number) {
  const oldest = Math.min(...recent);
  const retryAfter = Math.max(1, Math.ceil((oldest + REGISTER_WINDOW_MS - now) / 1000));
  return { ok: false as const, retryAfter };
}

/**
 * Record one registration for this IP, or refuse once the hour is full.
 * Parallel requests compare-and-swap on the counter so they cannot each
 * observe "under the limit" and all succeed.
 */
export async function reserveRegistration(
  s: RegistrationStore,
  ip: string,
  now = Date.now(),
): Promise<{ ok: true; at: number } | { ok: false; retryAfter: number }> {
  const result = await commitRecent<{ ok: true; at: number } | { ok: false; retryAfter: number }>(s, ip, now, (recent) => {
    if (recent.length >= REGISTER_LIMIT_PER_HOUR) return { kind: "stop", value: denied(recent, now) };
    return { kind: "write", recent: [...recent, now], value: { ok: true as const, at: now } };
  });
  return result ?? { ok: false, retryAfter: 1 };
}

/** Drop one reservation after a failed registration write, so a storage error does not burn the hour. */
export async function releaseRegistration(s: RegistrationStore, ip: string, at: number, now = Date.now()): Promise<void> {
  await commitRecent(s, ip, now, (recent) => {
    const idx = recent.indexOf(at);
    if (idx === -1) return { kind: "stop", value: undefined };
    const next = recent.slice();
    next.splice(idx, 1);
    return { kind: "write", recent: next, value: undefined };
  });
}

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
