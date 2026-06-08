// User management: CRUD + login + first-run bootstrap. All writes go through
// here so the safety rails (last-owner protection, self-lockout protection,
// session revocation) are centralized.
import crypto from "node:crypto";
import { pool } from "./db.js";
import { config } from "./config.js";
import { hashPassword, verifyPassword, isRole, destroyUserSessions, type Role } from "./auth.js";

export interface UserRow {
  id: number;
  username: string;
  email: string | null;
  role: Role;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
  createdBy: string | null;
}

const COLS = "id,username,email,role,status,created_at,last_login_at,created_by";
function mapRow(r: Record<string, unknown>): UserRow {
  return {
    id: Number(r.id),
    username: r.username as string,
    email: (r.email as string) ?? null,
    role: r.role as Role,
    status: r.status as string,
    createdAt: (r.created_at as Date)?.toISOString?.() ?? String(r.created_at),
    lastLoginAt: r.last_login_at ? (r.last_login_at as Date).toISOString() : null,
    createdBy: (r.created_by as string) ?? null,
  };
}

const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
const MIN_PW = 10;

export async function listUsers(): Promise<UserRow[]> {
  const { rows } = await pool!.query(`SELECT ${COLS} FROM console.users ORDER BY id`);
  return rows.map(mapRow);
}

export async function createUser(input: {
  username: string;
  password: string;
  role: string;
  email?: string;
  createdBy: string;
}): Promise<UserRow> {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) throw new Error("username must be 3–32 chars of [a-z0-9_.-]");
  if (!input.password || input.password.length < MIN_PW) throw new Error(`password must be ≥ ${MIN_PW} characters`);
  if (!isRole(input.role)) throw new Error("invalid role (viewer|operator|approver|owner)");
  const hash = await hashPassword(input.password);
  try {
    const { rows } = await pool!.query(
      `INSERT INTO console.users(username,email,password_hash,role,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
      [username, input.email?.trim() || null, hash, input.role, input.createdBy]
    );
    return mapRow(rows[0]);
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error("username already exists");
    throw e;
  }
}

export async function updateUser(
  id: number,
  patch: { role?: string; status?: string; password?: string; email?: string },
  actorId: number
): Promise<UserRow> {
  const target = await getById(id);
  if (!target) throw new Error("user not found");

  const sets: string[] = [];
  const vals: unknown[] = [];
  let revoke = false;

  if (patch.role !== undefined) {
    if (!isRole(patch.role)) throw new Error("invalid role");
    if (patch.role !== "owner") await assertNotLastOwner(target);
    sets.push(`role=$${sets.length + 1}`);
    vals.push(patch.role);
    revoke = true;
  }
  if (patch.status !== undefined) {
    if (!["active", "disabled"].includes(patch.status)) throw new Error("status must be active|disabled");
    if (patch.status === "disabled") {
      if (id === actorId) throw new Error("you cannot disable your own account");
      await assertNotLastOwner(target);
    }
    sets.push(`status=$${sets.length + 1}`);
    vals.push(patch.status);
    revoke = revoke || patch.status === "disabled";
  }
  if (patch.email !== undefined) {
    sets.push(`email=$${sets.length + 1}`);
    vals.push(patch.email.trim() || null);
  }
  if (patch.password !== undefined) {
    if (patch.password.length < MIN_PW) throw new Error(`password must be ≥ ${MIN_PW} characters`);
    sets.push(`password_hash=$${sets.length + 1}`);
    vals.push(await hashPassword(patch.password));
    revoke = true;
  }
  if (!sets.length) throw new Error("no changes supplied");
  sets.push(`updated_at=now()`);
  vals.push(id);

  const { rows } = await pool!.query(
    `UPDATE console.users SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING ${COLS}`,
    vals
  );
  if (revoke) await destroyUserSessions(id); // force re-login after role/pw/disable
  return mapRow(rows[0]);
}

export async function deleteUser(id: number, actorId: number): Promise<void> {
  if (id === actorId) throw new Error("you cannot delete your own account");
  const target = await getById(id);
  if (!target) throw new Error("user not found");
  await assertNotLastOwner(target);
  await pool!.query(`DELETE FROM console.users WHERE id=$1`, [id]);
}

/** Self-service password change — verifies the current password first. */
export async function changeOwnPassword(userId: number, current: string, next: string): Promise<void> {
  if (next.length < MIN_PW) throw new Error(`password must be ≥ ${MIN_PW} characters`);
  const { rows } = await pool!.query(`SELECT password_hash FROM console.users WHERE id=$1`, [userId]);
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) throw new Error("current password is incorrect");
  await pool!.query(`UPDATE console.users SET password_hash=$1, updated_at=now() WHERE id=$2`, [await hashPassword(next), userId]);
  // keep the current session valid; other sessions stay (only forced revoke on admin reset)
}

export async function login(username: string, password: string): Promise<{ id: number; username: string; role: Role } | null> {
  const { rows } = await pool!.query(
    `SELECT id,username,password_hash,role,status FROM console.users WHERE username=$1`,
    [username.trim().toLowerCase()]
  );
  const r = rows[0];
  if (!r || r.status !== "active" || !isRole(r.role)) {
    await verifyPassword(password, "scrypt$0$0"); // equalize timing vs the real path
    return null;
  }
  if (!(await verifyPassword(password, r.password_hash))) return null;
  await pool!.query(`UPDATE console.users SET last_login_at=now() WHERE id=$1`, [r.id]);
  return { id: Number(r.id), username: r.username, role: r.role };
}

export async function ensureBootstrapOwner(log: (m: string) => void): Promise<void> {
  const { rows } = await pool!.query(`SELECT count(*)::int AS n FROM console.users`);
  if (rows[0].n > 0) return;
  const username = config.bootstrap.username;
  const generated = !config.bootstrap.password;
  const password = config.bootstrap.password || crypto.randomBytes(12).toString("base64url");
  await createUser({ username, password, role: "owner", createdBy: "bootstrap" });
  if (generated) {
    log(`╔═ FIRST-RUN OWNER CREATED ═════════════════════════════════════════`);
    log(`║ username: ${username}`);
    log(`║ password: ${password}`);
    log(`║ CHANGE THIS after first login. Set CONSOLE_BOOTSTRAP_PASSWORD to avoid a random one.`);
    log(`╚═══════════════════════════════════════════════════════════════════`);
  } else {
    log(`bootstrap owner '${username}' created (password from CONSOLE_BOOTSTRAP_PASSWORD)`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function getById(id: number): Promise<{ role: Role; status: string } | null> {
  const { rows } = await pool!.query(`SELECT role,status FROM console.users WHERE id=$1`, [id]);
  return rows[0] ? { role: rows[0].role, status: rows[0].status } : null;
}
async function assertNotLastOwner(target: { role: Role; status: string }): Promise<void> {
  if (target.role !== "owner" || target.status !== "active") return; // only matters for an active owner
  const { rows } = await pool!.query(
    `SELECT count(*)::int AS n FROM console.users WHERE role='owner' AND status='active'`
  );
  if (rows[0].n <= 1) throw new Error("cannot remove/demote/disable the last active owner");
}
