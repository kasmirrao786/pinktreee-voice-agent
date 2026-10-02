"use client";

import { useFormState, useFormStatus } from "react-dom";
import type { AccountFormState } from "@/lib/actions/account";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export default function AccountForm({
  action,
  children,
  submitLabel,
}: {
  action: (prev: AccountFormState, formData: FormData) => Promise<AccountFormState>;
  children: React.ReactNode;
  submitLabel: string;
}) {
  const [state, formAction] = useFormState(action, undefined);

  return (
    <form action={formAction} className="space-y-3">
      {children}
      {state?.error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{state.error}</p>}
      {state?.success && <p className="text-sm text-green-600 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{state.success}</p>}
      <SubmitButton label={submitLabel} />
    </form>
  );
}
