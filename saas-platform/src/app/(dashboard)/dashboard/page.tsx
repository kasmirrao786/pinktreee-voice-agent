import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { StatCard, Badge, EmptyState, PageHeader } from "@/components/ui";

export default async function DashboardPage() {
  const { tenantId } = await requireSession();

  const [totalCalls, callsAgg, activeCampaigns, agentCount, recentCalls, agentUsage] = await Promise.all([
    prisma.call.count({ where: { tenantId } }),
    prisma.call.aggregate({ where: { tenantId }, _sum: { durationSeconds: true } }),
    prisma.campaign.count({ where: { tenantId, status: "running" } }),
    prisma.agent.count({ where: { tenantId } }),
    prisma.call.findMany({
      where: { tenantId },
      orderBy: { startedAt: "desc" },
      take: 8,
      include: { lead: true, agent: true },
    }),
    prisma.call.groupBy({
      by: ["agentId"],
      where: { tenantId },
      _count: { _all: true },
      orderBy: { _count: { agentId: "desc" } },
      take: 5,
    }),
  ]);

  const agents = await prisma.agent.findMany({
    where: { id: { in: agentUsage.map((a) => a.agentId) } },
    select: { id: true, name: true },
  });
  const agentNameById = Object.fromEntries(agents.map((a) => [a.id, a.name]));

  const totalMinutes = Math.round(((callsAgg._sum.durationSeconds || 0) / 60) * 10) / 10;

  return (
    <div>
      <PageHeader title="Overview" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total calls" value={totalCalls} />
        <StatCard label="Total calling minutes" value={totalMinutes} />
        <StatCard label="Active campaigns" value={activeCampaigns} />
        <StatCard label="Agents" value={agentCount} />
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card p-5">
          <h2 className="font-medium mb-4">Agent usage (by call volume)</h2>
          {agentUsage.length === 0 ? (
            <p className="text-sm text-gray-500">No calls yet.</p>
          ) : (
            <ul className="space-y-3">
              {agentUsage.map((row) => (
                <li key={row.agentId} className="flex items-center justify-between text-sm">
                  <span>{agentNameById[row.agentId] || "Unknown agent"}</span>
                  <span className="text-gray-500">{row._count._all} calls</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-medium">Recent calls</h2>
            <Link href="/calls" className="text-sm text-brand-600 hover:underline">
              View all
            </Link>
          </div>
          {recentCalls.length === 0 ? (
            <p className="text-sm text-gray-500">No calls yet — they&apos;ll show up here once campaigns start dialing.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {recentCalls.map((call) => (
                <li key={call.id} className="py-2.5 flex items-center justify-between text-sm">
                  <div>
                    <div className="font-medium">{call.lead?.name || call.lead?.phone || "Unknown lead"}</div>
                    <div className="text-gray-500 text-xs">{call.agent.name}</div>
                  </div>
                  <Badge status={call.status} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {totalCalls === 0 && (
        <div className="mt-8">
          <EmptyState
            title="No usage data yet"
            description="This will populate automatically once the calling engine (Project 1) starts placing calls, or once you seed fixture data."
          />
        </div>
      )}
    </div>
  );
}
