import type { CopilotStatus } from "@/lib/copilot-statechart";
import type { ErrorReason } from "@/lib/engine/types";
import { cn } from "@/lib/cn";

interface Descriptor {
  label: string;
  dot: string; // dot color class — the ONLY color; the rest stays monochrome
  live: boolean; // pulse while the engine is producing
}

function describe(status: CopilotStatus, errorReason: ErrorReason): Descriptor {
  switch (status) {
    case "thinking":
      return { label: "thinking", dot: "bg-ink-2", live: true };
    case "streaming":
      return { label: "streaming", dot: "bg-ink-2", live: true };
    case "awaitingApproval":
      return { label: "awaiting approval", dot: "bg-action", live: false };
    case "error":
      // A model pause is an EXPECTED state, not a fault: it takes the gate's
      // action colour (the same "system is holding on purpose" language), never
      // the error red. Only a real fault gets the error treatment.
      if (errorReason === "model_paused")
        return { label: "model paused", dot: "bg-action", live: false };
      if (errorReason === "rate_limit")
        return { label: "rate limited", dot: "bg-action", live: false };
      return { label: "error", dot: "bg-error", live: false };
    default:
      return { label: "idle", dot: "bg-ink-3", live: false };
  }
}

/** Live engine-state badge for the panel header. Dot carries the only color. */
export function StatusBadge({
  status,
  errorReason = "generic",
}: {
  status: CopilotStatus;
  errorReason?: ErrorReason;
}) {
  const { label, dot, live } = describe(status, errorReason);
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
      <span className={cn("size-1.5 rounded-full", dot, live && "animate-pulse")} />
      {label}
    </span>
  );
}
