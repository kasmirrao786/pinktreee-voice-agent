"use client";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <div className="text-2xl font-bold text-brand-600 mb-2">PinkTree</div>
        <h1 className="text-lg font-semibold mb-2">Something went wrong</h1>
        <p className="text-sm text-gray-500 mb-6">
          An unexpected error occurred. If this keeps happening, contact support with the details below.
        </p>
        {error.digest && <p className="text-xs text-gray-400 mb-4 font-mono">Error ID: {error.digest}</p>}
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
      </div>
    </div>
  );
}
