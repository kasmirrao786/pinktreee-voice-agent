import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";

export default async function AuditLogPage() {
  const logs = await prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const tenantIds = [...new Set(logs.map((l) => l.tenantId).filter(Boolean))] as string[];
  const tenants = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } });
  const tenantNameById = Object.fromEntries(tenants.map((t) => [t.id, t.name]));

  return (
    <div>
      <PageHeader title="Audit log" />
      <p className="text-sm text-gray-500 -mt-4 mb-6">
        Accountability record for sensitive platform-admin actions — tenant activation changes, system
        configuration edits, and team management.
      </p>

      {logs.length === 0 ? (
        <p className="text-sm text-gray-400 italic">No audit entries yet.</p>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">Actor</th>
                <th className="px-4 py-2">Action</th>
                <th className="px-4 py-2">Tenant</th>
                <th className="px-4 py-2">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-2 text-xs text-gray-500">{new Date(log.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-2">{log.actorEmail}</td>
                  <td className="px-4 py-2 font-mono text-xs">{log.action}</td>
                  <td className="px-4 py-2">{log.tenantId ? tenantNameById[log.tenantId] || log.tenantId : "—"}</td>
                  <td className="px-4 py-2 text-xs text-gray-500">
                    {log.targetType ? `${log.targetType}${log.targetId ? `:${log.targetId}` : ""}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
