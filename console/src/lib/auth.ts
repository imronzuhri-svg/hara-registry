// Console auth client — login/logout/session + user CRUD. credentials:"include"
// so the session cookie rides cross-origin in dev (same-origin in prod = no-op).
const API = import.meta.env.VITE_API_BASE ?? "/api";

export type Role = "viewer" | "operator" | "approver" | "owner";
export const ROLES: Role[] = ["viewer", "operator", "approver", "owner"];
const RANK: Record<Role, number> = { viewer: 1, operator: 2, approver: 3, owner: 4 };
export const atLeast = (have: Role | undefined, min: Role): boolean => (have ? RANK[have] : 0) >= RANK[min];
export const roleLabel: Record<Role, string> = {
  viewer: "Viewer · read-only",
  operator: "Operator · funding/registry/snapshots",
  approver: "Approver · governance",
  owner: "Owner · full + user management",
};

export interface AuthUser {
  id: number;
  username: string;
  role: Role;
}
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

async function j<T = unknown>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((body.error as string) ?? `HTTP ${res.status}`);
  return body as T;
}

export async function fetchMe(): Promise<{ user: AuthUser | null; authEnabled: boolean }> {
  const res = await fetch(`${API}/auth/me`, { credentials: "include" });
  if (res.status === 401) return { user: null, authEnabled: true };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const login = (username: string, password: string) =>
  j<{ user: AuthUser }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }).then((r) => r.user);
export const logout = () => j("/auth/logout", { method: "POST" });
export const changePassword = (current: string, next: string) =>
  j("/auth/password", { method: "POST", body: JSON.stringify({ current, next }) });

export const listUsers = () => j<{ users: UserRow[] }>("/users").then((r) => r.users);
export const createUser = (u: { username: string; password: string; role: Role; email?: string }) =>
  j<{ user: UserRow }>("/users", { method: "POST", body: JSON.stringify(u) }).then((r) => r.user);
export const updateUser = (id: number, patch: Partial<{ role: Role; status: string; password: string; email: string }>) =>
  j<{ user: UserRow }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then((r) => r.user);
export const deleteUser = (id: number) => j(`/users/${id}`, { method: "DELETE" });
