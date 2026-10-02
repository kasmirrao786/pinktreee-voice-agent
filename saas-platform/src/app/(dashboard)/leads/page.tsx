import Link from "next/link";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import AddLeadForm from "@/components/AddLeadForm";
import CsvImportForm from "@/components/CsvImportForm";
import Pagination from "@/components/Pagination";

const PAGE_SIZE = 25;

const SORT_OPTIONS: Record<string, any> = {
  newest: { createdAt: "desc" },
  oldest: { createdAt: "asc" },
  name: { name: "asc" },
};

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: { q?: string; status?: string; sort?: string; page?: string };
}) {
  const { tenantId } = await requireSession();

  const q = searchParams.q?.trim();
  const status = searchParams.status;
  const sort = searchParams.sort || "newest";
  const page = Math.max(1, parseInt(searchParams.page || "1", 10) || 1);

  const where: any = { tenantId };
  if (status) where.status = status;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
    ];
  }

  const [leads, total, statuses] = await Promise.all([
    prisma.lead.findMany({
      where,
      orderBy: SORT_OPTIONS[sort] || SORT_OPTIONS.newest,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.lead.count({ where }),
    prisma.lead.findMany({ where: { tenantId }, select: { status: true }, distinct: ["status"] }),
  ]);

  return (
    <div>
      <PageHeader title="Leads" />

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <AddLeadForm />

        <div className="card p-4 flex flex-col justify-center">
          <div className="text-sm font-medium mb-2">Bulk import</div>
          <CsvImportForm />
        </div>
      </div>

      <form className="flex flex-wrap gap-3 mb-4" method="get">
        <input name="q" defaultValue={q} placeholder="Search name, phone, email, company…" className="input max-w-xs" />
        <select name="status" defaultValue={status || ""} className="input max-w-[160px]">
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.status} value={s.status}>
              {s.status}
            </option>
          ))}
        </select>
        <select name="sort" defaultValue={sort} className="input max-w-[160px]">
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name (A–Z)</option>
        </select>
        <button type="submit" className="btn-secondary">
          Apply
        </button>
      </form>

      {leads.length === 0 ? (
        <EmptyState title="No leads found" description="Add a lead manually or import a CSV to get started." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-gray-500">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Phone</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Company</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Tags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {leads.map((lead) => (
                <tr key={lead.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link href={`/leads/${lead.id}`} className="text-brand-600 hover:underline font-medium">
                      {lead.name || "—"}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{lead.phone || "—"}</td>
                  <td className="px-4 py-2">{lead.email || "—"}</td>
                  <td className="px-4 py-2">{lead.company || "—"}</td>
                  <td className="px-4 py-2">
                    <Badge status={lead.status} />
                  </td>
                  <td className="px-4 py-2 text-xs text-gray-500">{lead.tags.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/leads" searchParams={{ q, status, sort }} />
    </div>
  );
}
