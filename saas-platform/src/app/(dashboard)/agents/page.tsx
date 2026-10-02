import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, PageHeader } from "@/components/ui";

export default async function AgentsPage() {
  const { tenantId, role } = await requireSession();
  const canEdit = role === "owner" || role === "admin";
  const agents = await prisma.agent.findMany({
    where: { tenantId },
    include: { assignedPhoneNumber: true, _count: { select: { calls: true, knowledgeSources: true } } },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader
        title="Agents"
        action={
          canEdit ? (
            <Link href="/agents/new" className="btn-primary">
              + New agent
            </Link>
          ) : undefined
        }
      />

      {agents.length === 0 ? (
        <EmptyState title="No agents yet" description="Create your first AI voice agent to get started." />
      ) : (
        <div className="card divide-y divide-gray-100">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${agent.id}`}
              className="flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition"
            >
              <div>
                <div className="font-medium">{agent.name}</div>
                <div className="text-sm text-gray-500">
                  {agent.description || "No description"}
                  {agent.assignedPhoneNumber && ` · ${agent.assignedPhoneNumber.e164Number}`}
                </div>
              </div>
              <div className="flex items-center gap-4 text-sm text-gray-500">
                <span>{agent._count.calls} calls</span>
                <span>{agent._count.knowledgeSources} sources</span>
                <Badge status={agent.isEnabled ? "active" : "disabled"} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
