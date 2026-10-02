"use client";

import { useFormState, useFormStatus } from "react-dom";
import { importLeadsCsvAction } from "@/lib/actions/leads";

type ImportState = { error?: string; imported?: number; skipped?: number } | undefined;

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn-secondary" disabled={pending}>
      {pending ? "Importing…" : "Import CSV"}
    </button>
  );
}

export default function CsvImportForm() {
  const [state, formAction] = useFormState<ImportState, FormData>(
    async (_prev, formData) => importLeadsCsvAction(formData),
    undefined
  );

  return (
    <form action={formAction} className="flex items-center gap-3">
      <input type="file" name="file" accept=".csv" required className="text-sm" />
      <SubmitButton />
      {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      {state?.imported !== undefined && (
        <span className="text-sm text-green-600">
          Imported {state.imported}
          {state.skipped ? `, skipped ${state.skipped}` : ""}
        </span>
      )}
    </form>
  );
}
