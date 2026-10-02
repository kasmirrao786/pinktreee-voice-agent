import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { Badge, PageHeader, StatCard } from "@/components/ui";
import { setTenantActiveAction } from "@/lib/actions/admin";

export default async function AdminTenantDetailPage({ params }: { params: { id: string } }) {
  const tenant = await prisma.tenant.findUnique({ where: { id: params.id } });
  if (!tenant) notFound();

  const [users, agents, campaigns, calls] = await Promise.all([
    prisma.user.findMany({ where: { tenantId: tenant.id } }),
    prisma.agent.findMany({ where: { tenantId: tenant.id } }),
    prisma.campaign.findMany({ where: { tenantId: tenant.id } }),
    prisma.call.count({ where: { tenantId: tenant.id } }),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader
        title={tenant.name}
        action={
          <form action={setTenantActiveAction.bind(null, tenant.id, !tenant.isActive)}>
            <button type="submit" className={tenant.isActive ? "btn-danger" : "btn-primary"}>
              {tenant.isActive ? "Deactivate account" : "Activate account"}
            </button>
          </form>
        }
      />

      <div className="flex items-center gap-3">
        <Badge status={tenant.isActive ? "active" : "inactive"} />
        <span className="text-sm text-gray-500 capitalize">{tenant.plan} plan</span>
        <span className="text-sm text-gray-500">Joined {new Date(tenant.createdAt).toLocaleDateString()}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Users" value={users.length} />
        <StatCard label="Agents" value={agents.length} />
        <StatCard label="Campaigns" value={campaigns.length} />
        <StatCard label="Total calls" value={calls} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium mb-3">Users</h2>
          <ul className="text-sm divide-y divide-gray-100">
            {users.map((u) => (
              <li key={u.id} className="py-2 flex justify-between">
                <span>{u.email}</span>
                <span className="text-gray-500 capitalize">{u.role}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="card p-5">
          <h2 className="font-medium mb-3">Agents</h2>
          <ul className="text-sm divide-y divide-gray-100">
            {agents.map((a) => (
              <li key={a.id} className="py-2 flex justify-between">
                <span>{a.name}</span>
                <Badge status={a.isEnabled ? "active" : "disabled"} />
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card p-5">
        <h2 className="font-medium mb-3">Campaigns</h2>
        <ul className="text-sm divide-y divide-gray-100">
          {campaigns.map((c) => (
            <li key={c.id} className="py-2 flex justify-between">
              <span>{c.name}</span>
              <Badge status={c.status} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
