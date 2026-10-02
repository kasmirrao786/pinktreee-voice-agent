import Link from "next/link";
import { logoutAction } from "@/lib/actions/auth";

const NAV = [
  { href: "/dashboard", label: "Overview", icon: "📊" },
  { href: "/agents", label: "Agents", icon: "🤖" },
  { href: "/leads", label: "Leads", icon: "👥" },
  { href: "/campaigns", label: "Campaigns", icon: "📣" },
  { href: "/calls", label: "Calls", icon: "📞" },
  { href: "/settings/telephony", label: "Telephony", icon: "☎️" },
  { href: "/settings/team", label: "Team", icon: "🧑‍🤝‍🧑" },
  { href: "/settings/account", label: "Account", icon: "⚙️" },
];

export default function Sidebar({ tenantName, email }: { tenantName: string; email: string }) {
  return (
    <aside className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col h-screen sticky top-0">
      <div className="px-5 py-5 border-b border-gray-100">
        <div className="text-lg font-bold text-brand-600">PinkTree</div>
        <div className="text-xs text-gray-500 truncate mt-0.5">{tenantName}</div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-1">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 hover:bg-brand-50 hover:text-brand-700 transition"
          >
            <span>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>
      <div className="px-3 py-4 border-t border-gray-100">
        <div className="text-xs text-gray-500 px-3 truncate mb-2">{email}</div>
        <form action={logoutAction}>
          <button type="submit" className="w-full text-left rounded-lg px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
