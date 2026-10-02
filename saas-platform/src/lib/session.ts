import { cookies } from "next/headers";
import { getIronSession, IronSession, SessionOptions } from "iron-session";
import { redirect } from "next/navigation";
import { prisma } from "./db";

export interface SessionData {
  userId?: string;
  tenantId?: string;
  role?: "owner" | "admin" | "member" | "platform_admin";
  email?: string;
}

const sessionOptions: SessionOptions = {
  password: process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me-32chars",
  cookieName: "pinktree_session",
  cookieOptions: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};

/** Every account belongs to a tenant. This is the single place session state is read/written —
 * every route/page that needs the logged-in user's tenant MUST go through this, so there is no
 * code path that can read another customer's data by accident. */
export async function getSession(): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(cookies(), sessionOptions);
}

/** Use in server components/pages: redirects to /login if not authenticated.
 * Returns the session data (userId, tenantId, role) for tenant-scoped queries. */
export async function requireSession(): Promise<Required<Pick<SessionData, "userId" | "tenantId" | "role" | "email">>> {
  const session = await getSession();
  if (!session.userId || !session.tenantId) {
    redirect("/login");
  }
  return {
    userId: session.userId!,
    tenantId: session.tenantId!,
    role: session.role!,
    email: session.email!,
  };
}

/** Use for the platform admin panel — distinct from customer tenant accounts. */
export async function requirePlatformAdmin(): Promise<Required<Pick<SessionData, "userId" | "email">>> {
  const session = await getSession();
  if (!session.userId || session.role !== "platform_admin") {
    redirect("/login");
  }
  return { userId: session.userId!, email: session.email! };
}

/** Throws a plain Error (not a redirect) for use inside server actions where a
 * denied action should surface as an inline form error rather than a page
 * navigation. Call after requireSession() with the roles allowed to proceed. */
export function assertRole(currentRole: string, allowed: SessionData["role"][]) {
  if (!allowed.includes(currentRole as SessionData["role"])) {
    throw new Error("You don't have permission to do that. Ask a workspace owner or admin.");
  }
}

/** Confirms the tenant is active (not deactivated by a platform admin) on every authenticated load. */
export async function assertTenantActive(tenantId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { isActive: true } });
  if (!tenant || !tenant.isActive) {
    redirect("/login?deactivated=1");
  }
}
