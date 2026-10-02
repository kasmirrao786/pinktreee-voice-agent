import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader, Badge } from "@/components/ui";
import InviteTeammateForm from "@/components/InviteTeammateForm";
import ConfirmActionButton from "@/components/ConfirmActionButton";
import RoleSelect from "@/components/RoleSelect";
import { revokeInviteAction, updateUserRoleAction, removeUserAction } from "@/lib/actions/team";

export default async function TeamPage() {
  const { tenantId, role, userId } = await requireSession();
  const canManage = role === "owner" || role === "admin";

  const [users, invites] = await Promise.all([
    prisma.user.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    prisma.invite.findMany({ where: { tenantId, acceptedAt: null }, orderBy: { createdAt: "desc" } }),
  ]);

  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Team" />

      {canManage && (
        <div className="card p-6">
          <h2 className="font-medium mb-3">Invite a teammate</h2>
          <InviteTeammateForm canInviteAdmins={role === "owner"} />
        </div>
      )}

      <div className="card p-6">
        <h2 className="font-medium mb-3">Members</h2>
        <ul className="divide-y divide-gray-100">
          {users.map((u) => (
            <li key={u.id} className="py-3 flex items-center justify-between text-sm">
              <div>
                <div className="font-medium">
                  {u.email} {u.id === userId && <span className="text-gray-400">(you)</span>}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {role === "owner" && u.role !== "owner" ? (
                  <RoleSelect action={updateUserRoleAction.bind(null, u.id)} defaultValue={u.role} />
                ) : (
                  <Badge status={u.role} />
                )}
                {canManage && u.role !== "owner" && u.id !== userId && (
                  <ConfirmActionButton
                    action={removeUserAction.bind(null, u.id)}
                    confirmText={`Remove ${u.email} from this workspace?`}
                    label="Remove"
                    pendingLabel="Removing…"
                    className="text-xs text-red-600 hover:underline"
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {canManage && invites.length > 0 && (
        <div className="card p-6">
          <h2 className="font-medium mb-3">Pending invites</h2>
          <ul className="divide-y divide-gray-100">
            {invites.map((inv) => (
              <li key={inv.id} className="py-3 flex items-center justify-between text-sm">
                <div>
                  <div className="font-medium">{inv.email}</div>
                  <div className="text-xs text-gray-400">
                    Invited as {inv.role} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </div>
                </div>
                <form action={revokeInviteAction.bind(null, inv.id)}>
                  <button type="submit" className="text-xs text-red-600 hover:underline">
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
