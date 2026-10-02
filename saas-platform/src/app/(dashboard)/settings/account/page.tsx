import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/ui";
import AccountForm from "@/components/AccountForm";
import { updateWorkspaceNameAction, changePasswordAction } from "@/lib/actions/account";

export default async function AccountPage() {
  const { tenantId, email, role } = await requireSession();
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

  return (
    <div className="max-w-lg space-y-6">
      <PageHeader title="Account" />

      <div className="card p-6">
        <h2 className="font-medium mb-3">Workspace</h2>
        {role === "owner" ? (
          <AccountForm action={updateWorkspaceNameAction} submitLabel="Save">
            <div>
              <label className="label">Workspace name</label>
              <input name="name" defaultValue={tenant.name} required className="input" />
            </div>
            <div>
              <label className="label">Plan</label>
              <input value={tenant.plan} disabled className="input bg-gray-50 text-gray-500" />
            </div>
          </AccountForm>
        ) : (
          <div className="text-sm space-y-1">
            <div>
              <span className="text-gray-500">Name: </span>
              {tenant.name}
            </div>
            <div>
              <span className="text-gray-500">Plan: </span>
              <span className="capitalize">{tenant.plan}</span>
            </div>
            <p className="text-xs text-gray-400 mt-2">Only the workspace owner can rename the workspace.</p>
          </div>
        )}
      </div>

      <div className="card p-6">
        <h2 className="font-medium mb-3">Your login</h2>
        <p className="text-sm text-gray-500 mb-4">{email}</p>
        <AccountForm action={changePasswordAction} submitLabel="Change password">
          <div>
            <label className="label">Current password</label>
            <input name="currentPassword" type="password" required className="input" />
          </div>
          <div>
            <label className="label">New password</label>
            <input name="newPassword" type="password" required minLength={8} className="input" />
          </div>
        </AccountForm>
      </div>
    </div>
  );
}
