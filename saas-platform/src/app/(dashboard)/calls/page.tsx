import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import Pagination from "@/components/Pagination";

const PAGE_SIZE = 25;

export default async function CallsPage({ searchParams }: { searchParams: { page?: string } }) {
  const { tenantId } = await requireSession();
  const page = Math.max(1, parseInt(searchParams.page || "1", 10) || 1);

  const [calls, total] = await Promise.all([
    prisma.call.findMany({
      where: { tenantId },
      include: { lead: true, agent: true, campaign: true },
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.call.count({ where: { tenantId } }),
  ]);

  return (
    <div>
      <PageHeader title="Calls" />
      {calls.length === 0 ? (
        <EmptyState title="No calls yet" description="Call records will appear here once campaigns start dialing or calls come in." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">Lead</th>
                <th className="px-4 py-2">Agent</th>
                <th className="px-4 py-2">Campaign</th>
                <th className="px-4 py-2">Started</th>
                <th className="px-4 py-2">Duration</th>
                <th className="px-4 py-2">Outcome</th>
                <th className="px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {calls.map((call) => (
                <tr key={call.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/calls/${call.id}`} className="text-brand-600 hover:underline font-medium">
                      {call.lead?.name || call.lead?.phone || "Unknown"}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{call.agent.name}</td>
                  <td className="px-4 py-2">{call.campaign?.name || "—"}</td>
                  <td className="px-4 py-2 text-xs">{call.startedAt ? new Date(call.startedAt).toLocaleString() : "—"}</td>
                  <td className="px-4 py-2">{call.durationSeconds ? `${Math.round(call.durationSeconds / 60)}m` : "—"}</td>
                  <td className="px-4 py-2 text-xs">{call.outcome || "—"}</td>
                  <td className="px-4 py-2">
                    <Badge status={call.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/calls" />
    </div>
  );
}
