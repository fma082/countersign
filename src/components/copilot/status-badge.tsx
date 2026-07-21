import type { CopilotStatus } from "@/lib/copilot-statechart";
import { cn } from "@/lib/cn";

interface Descriptor {
  label: string;
  dot: string; // dot color class — the ONLY color; the rest stays monochrome
  live: boolean; // pulse while the engine is producing
}

function describe(status: CopilotStatus): Descriptor {
  switch (status) {
    case "thinking":
      return { label: "thinking", dot: "bg-ink-2", live: true };
    case "streaming":
      return { label: "streaming", dot: "bg-ink-2", live: true };
    case "awaitingApproval":
      return { label: "awaiting approval", dot: "bg-action", live: false };
    case "error":
      return { label: "error", dot: "bg-error", live: false };
    default:
      return { label: "idle", dot: "bg-ink-3", live: false };
  }
}

/** Live engine-state badge for the panel header. Dot carries the only color. */
export function StatusBadge({ status }: { status: CopilotStatus }) {
  const { label, dot, live } = describe(status);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
      <span className={cn("size-1.5 rounded-full", dot, live && "animate-pulse")} />
      {label}
    </span>
  );
}
