import { redirect } from "next/navigation";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import AgentForm from "@/components/AgentForm";
import { createAgentAction } from "@/lib/actions/agents";

export default async function NewAgentPage() {
  const { tenantId, role } = await requireSession();
  if (role !== "owner" && role !== "admin") redirect("/agents");
  const phoneNumbers = await prisma.phoneNumber.findMany({ where: { tenantId } });

  return (
    <div className="max-w-2xl">
      <PageHeader title="New agent" />
      <AgentForm action={createAgentAction} phoneNumbers={phoneNumbers} submitLabel="Create agent" />
    </div>
  );
}
