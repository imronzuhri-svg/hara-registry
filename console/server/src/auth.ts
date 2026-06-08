// Authentication primitives: password hashing (scrypt — Node built-in, no native
// dep), server-side sessions (random token, only its SHA-256 stored), and the
// role hierarchy. Sessions are revocable (disabling a user or changing their
// password/role deletes their sessions — see users.ts).
import crypto from "node:crypto";
import { promisify } from "node:util";
import { pool } from "./db.js";
import { config } from "./config.js";

const scrypt = promisify(crypto.scrypt);

// ── Roles ────────────────────────────────────────────────────────────────────
export type Role = "viewer" | "operator" | "approver" | "owner";
export const ROLES: Role[] = ["viewer", "operator", "approver", "owner"];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, approver: 3, owner: 4 };
export function isRole(r: string): r is Role {
  return (ROLES as string[]).includes(r);
}
export function roleAtLeast(have: string, min: Role): boolean {
  return (RANK[have as Role] ?? 0) >= RANK[min];
}

// ── Passwords (scrypt) ───────────────────────────────────────────────────────
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const dk = (await scrypt(pw, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${dk.toString("hex")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  let want: Buffer;
  try {
    want = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }
  const dk = (await scrypt(pw, Buffer.from(saltHex, "hex"), want.length || 64)) as Buffer;
  return dk.length === want.length && crypto.timingSafeEqual(dk, want);
}

// ── Sessions ─────────────────────────────────────────────────────────────────
export interface SessionUser {
  id: number;
  username: string;
  role: Role;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export async function createSession(userId: number, userAgent: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.session.ttlHours * 3600 * 1000);
  await pool!.query(
    `INSERT INTO console.sessions(token_hash, user_id, expires_at, user_agent) VALUES ($1,$2,$3,$4)`,
    [sha256(token), userId, expires, userAgent.slice(0, 300)]
  );
  return token;
}

export async function resolveSession(token: string | undefined): Promise<SessionUser | null> {
  if (!token || !pool) return null;
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.status
       FROM console.sessions s JOIN console.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  const r = rows[0];
  if (!r || r.status !== "active" || !isRole(r.role)) return null;
  return { id: Number(r.id), username: r.username, role: r.role };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token || !pool) return;
  await pool.query(`DELETE FROM console.sessions WHERE token_hash = $1`, [sha256(token)]);
}

export async function destroyUserSessions(userId: number): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM console.sessions WHERE user_id = $1`, [userId]);
}
