"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export default function ConfirmActionButton({
  action,
  confirmText,
  label = "Delete",
  pendingLabel = "Working…",
  className = "text-sm text-red-600 hover:underline",
  redirectTo,
}: {
  action: () => Promise<{ error?: string } | void>;
  confirmText: string;
  label?: string;
  pendingLabel?: string;
  className?: string;
  redirectTo?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <div>
      <button
        type="button"
        className={className}
        disabled={isPending}
        onClick={() => {
          if (!window.confirm(confirmText)) return;
          setError(null);
          startTransition(async () => {
            const result = await action();
            if (result?.error) {
              setError(result.error);
            } else if (redirectTo) {
              router.push(redirectTo);
            }
          });
        }}
      >
        {isPending ? pendingLabel : label}
      </button>
      {error && <p className="text-xs text-red-600 mt-1 max-w-xs">{error}</p>}
    </div>
  );
}
