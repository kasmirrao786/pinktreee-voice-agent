import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/session";
import { logoutAction } from "@/lib/actions/auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { email } = await requirePlatformAdmin();

  return (
    <div className="min-h-screen">
      <header className="bg-gray-900 text-white px-8 py-4 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <span className="font-bold">PinkTree</span>
            <span className="ml-2 text-xs bg-brand-600 rounded-full px-2 py-0.5">Platform Admin</span>
          </div>
          <nav className="flex items-center gap-4 text-sm text-gray-300">
            <Link href="/admin" className="hover:text-white">
              Tenants
            </Link>
            <Link href="/admin/settings" className="hover:text-white">
              Settings
            </Link>
            <Link href="/admin/audit-log" className="hover:text-white">
              Audit log
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-gray-300">{email}</span>
          <form action={logoutAction}>
            <button type="submit" className="text-gray-300 hover:text-white">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="p-8 max-w-6xl mx-auto">{children}</main>
    </div>
  );
}
