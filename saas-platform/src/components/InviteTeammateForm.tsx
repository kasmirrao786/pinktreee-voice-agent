"use client";

import { useFormState, useFormStatus } from "react-dom";
import { inviteTeammateAction, type TeamFormState } from "@/lib/actions/team";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Sending…" : "Send invite"}
    </button>
  );
}

export default function InviteTeammateForm({ canInviteAdmins }: { canInviteAdmins: boolean }) {
  const [state, formAction] = useFormState<TeamFormState, FormData>(inviteTeammateAction, undefined);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label className="label">Email</label>
        <input name="email" type="email" required className="input" placeholder="teammate@company.com" />
      </div>
      <div>
        <label className="label">Role</label>
        <select name="role" className="input" defaultValue="member">
          <option value="member">Member</option>
          {canInviteAdmins && <option value="admin">Admin</option>}
        </select>
      </div>
      <SubmitButton />
      {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      {state?.success && <span className="text-sm text-green-600">{state.success}</span>}
    </form>
  );
}
