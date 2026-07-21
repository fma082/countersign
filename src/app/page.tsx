import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

/** Placeholder home. The real home ships in a later iteration. */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-8 py-16">
      <div className="mb-10 flex items-center justify-between">
        <span className="font-mono text-[12px] text-ink-3">countersign</span>
        <ThemeToggle />
      </div>

      <h1 className="text-3xl font-medium tracking-[-0.02em] text-ink">Countersign</h1>
      <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-2">
        An AI agent operating a fictional admin panel against a real local model,
        with a human checkpoint before the irreversible operations. Reads run on
        their own. Reversible writes run, then wait. Destructive writes wait
        first — friction before or friction after, never both.
      </p>

      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/scenario"
          className="inline-flex items-center justify-between gap-3 rounded-token bg-action px-5 py-3 text-[14px] font-medium text-on-action transition-opacity hover:opacity-90"
        >
          Open the scenario <ArrowRight size={16} />
        </Link>
        <Link
          href="/tokens"
          className="inline-flex items-center justify-between gap-3 rounded-token border border-line px-5 py-3 text-[14px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          Token system <ArrowRight size={16} />
        </Link>
      </div>

      <p className="mt-16 text-[12px] text-ink-3">
        This is a portfolio piece. Northbase and its catalog are entirely
        fictional.
      </p>
    </main>
  );
}
