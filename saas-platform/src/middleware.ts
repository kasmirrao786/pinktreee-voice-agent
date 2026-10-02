import { NextRequest, NextResponse } from "next/server";
import { unsealData } from "iron-session";

// Global route guard. Every tenant-scoped area of the app is gated here,
// not per-route — the goal is that there is no code path that can serve
// dashboard/admin/API data without a verified session, regardless of
// whether an individual page or route handler remembers to check.
const PUBLIC_PATHS = ["/login", "/register", "/reset-password", "/invite", "/api/auth", "/api/health"];

const SESSION_COOKIE = "pinktree_session";
const SESSION_PASSWORD = process.env.SESSION_SECRET || "dev-only-insecure-secret-change-me-32chars";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const data = await unsealData<{ userId?: string; tenantId?: string; role?: string }>(raw, {
      password: SESSION_PASSWORD,
    });

    if (!data.userId) {
      return NextResponse.redirect(new URL("/login", req.url));
    }

    if (pathname.startsWith("/admin")) {
      if (data.role !== "platform_admin") {
        return NextResponse.redirect(new URL("/dashboard", req.url));
      }
    } else if (!data.tenantId) {
      // Every non-admin, non-public route requires a resolved tenant.
      return NextResponse.redirect(new URL("/login", req.url));
    }

    return NextResponse.next();
  } catch {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}

export const config = {
  matcher: ["/dashboard/:path*", "/agents/:path*", "/leads/:path*", "/campaigns/:path*", "/calls/:path*", "/settings/:path*", "/admin/:path*", "/api/:path*"],
};
