import Link from "next/link";
import { prisma } from "@/lib/db";
import { Badge, PageHeader, StatCard } from "@/components/ui";
import { setTenantActiveAction } from "@/lib/actions/admin";

export default async function AdminHomePage() {
  const [tenants, totalCalls, totalAgents, totalCampaigns] = await Promise.all([
    prisma.tenant.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { calls: true, agents: true, campaigns: true, users: true } } },
    }),
    prisma.call.count(),
    prisma.agent.count(),
    prisma.campaign.count(),
  ]);

  return (
    <div>
      <PageHeader title="Platform overview" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Tenants" value={tenants.length} />
        <StatCard label="Total calls" value={totalCalls} />
        <StatCard label="Total agents" value={totalAgents} />
        <StatCard label="Total campaigns" value={totalCampaigns} />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th className="px-4 py-2">Tenant</th>
              <th className="px-4 py-2">Plan</th>
              <th className="px-4 py-2">Users</th>
              <th className="px-4 py-2">Agents</th>
              <th className="px-4 py-2">Campaigns</th>
              <th className="px-4 py-2">Calls</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {tenants.map((t) => (
              <tr key={t.id} className="hover:bg-gray-50">
                <td className="px-4 py-2">
                  <Link href={`/admin/tenants/${t.id}`} className="text-brand-600 hover:underline font-medium">
                    {t.name}
                  </Link>
                </td>
                <td className="px-4 py-2 capitalize">{t.plan}</td>
                <td className="px-4 py-2">{t._count.users}</td>
                <td className="px-4 py-2">{t._count.agents}</td>
                <td className="px-4 py-2">{t._count.campaigns}</td>
                <td className="px-4 py-2">{t._count.calls}</td>
                <td className="px-4 py-2">
                  <Badge status={t.isActive ? "active" : "inactive"} />
                </td>
                <td className="px-4 py-2">
                  <form action={setTenantActiveAction.bind(null, t.id, !t.isActive)}>
                    <button type="submit" className="text-sm text-brand-600 hover:underline">
                      {t.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
