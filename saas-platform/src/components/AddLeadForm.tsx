"use client";

import { useFormState, useFormStatus } from "react-dom";
import { createLeadAction, type LeadFormState } from "@/lib/actions/leads";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-primary col-span-2" disabled={pending}>
      {pending ? "Adding…" : "+ Add lead"}
    </button>
  );
}

export default function AddLeadForm() {
  const [state, formAction] = useFormState<LeadFormState, FormData>(createLeadAction, undefined);

  return (
    <form action={formAction} className="card p-4 grid grid-cols-2 gap-2">
      <input name="name" placeholder="Name" className="input" />
      <input name="phone" placeholder="Phone" className="input" />
      <input name="email" placeholder="Email" className="input" />
      <input name="company" placeholder="Company" className="input" />
      {state?.error && <p className="col-span-2 text-sm text-red-600">{state.error}</p>}
      <SubmitButton />
    </form>
  );
}
