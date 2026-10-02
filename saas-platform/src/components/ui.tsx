export function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs text-gray-400 mt-1">{sub}</div>}
    </div>
  );
}

const BADGE_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700",
  completed: "bg-green-100 text-green-700",
  indexed: "bg-green-100 text-green-700",
  connected: "bg-green-100 text-green-700",
  qualified: "bg-green-100 text-green-700",
  running: "bg-blue-100 text-blue-700",
  in_progress: "bg-blue-100 text-blue-700",
  scheduled: "bg-blue-100 text-blue-700",
  processing: "bg-amber-100 text-amber-700",
  queued: "bg-amber-100 text-amber-700",
  new: "bg-amber-100 text-amber-700",
  paused: "bg-gray-200 text-gray-700",
  draft: "bg-gray-200 text-gray-700",
  disabled: "bg-gray-200 text-gray-700",
  inactive: "bg-gray-200 text-gray-700",
  failed: "bg-red-100 text-red-700",
  no_answer: "bg-red-100 text-red-700",
  unqualified: "bg-red-100 text-red-700",
  lost: "bg-red-100 text-red-700",
};

export function Badge({ status }: { status: string }) {
  const color = BADGE_COLORS[status] || "bg-gray-100 text-gray-700";
  return <span className={`badge ${color}`}>{status.replace(/_/g, " ")}</span>;
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="card p-10 text-center">
      <div className="text-gray-900 font-medium">{title}</div>
      <div className="text-sm text-gray-500 mt-1">{description}</div>
    </div>
  );
}

export function PageHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      {action}
    </div>
  );
}
