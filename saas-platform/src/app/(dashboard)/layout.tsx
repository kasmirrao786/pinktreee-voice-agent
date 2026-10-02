import { requireSession, assertTenantActive } from "@/lib/session";
import { prisma } from "@/lib/db";
import Sidebar from "@/components/Sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { tenantId, email } = await requireSession();
  await assertTenantActive(tenantId);

  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } });

  return (
    <div className="flex min-h-screen">
      <Sidebar tenantName={tenant.name} email={email} />
      <main className="flex-1 p-8 max-w-6xl">{children}</main>
    </div>
  );
}
