import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { AppShot, AppShotMobile } from "@/components/home/app-shot";

const CLAIMS = [
  {
    title: "Reads run alone",
    body: "Query and filter execute on their own — the table reacts live, nothing waits.",
  },
  {
    title: "Reversible writes wait",
    body: "A radius-1 change runs immediately, then waits: undo lives on the action until the next write.",
  },
  {
    title: "Destructive writes halt",
    body: "The engine stops at the gate. Nothing irreversible runs until you approve — all, some, or none.",
  },
];

const CATALOG = [
  { n: "01", name: "Copilot Chat Panel", line: "The transcript state machine behind the panel.", count: "8 states" },
  { n: "02", name: "AI Response Loading States", line: "Thinking, streaming, tool calls, done.", count: "4 variants" },
  { n: "03", name: "Suggested Prompts & Smart Input", line: "Guided start, then free input on completion.", count: "5 states" },
  { n: "04", name: "Human-in-the-Loop Approval", line: "The wedge — reads, reversible writes, and the gate, by a radius + window criterion.", count: "the wedge", wedge: true },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-8 sm:px-8">
      <header className="flex items-center justify-between">
        <span className="font-mono text-[12px] text-ink-3">countersign</span>
        <ThemeToggle />
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="grid items-center gap-10 pt-16 pb-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-14 lg:pt-24">
        <div>
          <h1 className="text-4xl font-medium leading-[1.05] tracking-[-0.03em] text-ink sm:text-5xl">
            Reads run alone.
            <br />
            Writes wait for you.
          </h1>
          <p className="mt-6 max-w-md text-[16px] leading-relaxed text-ink-2">
            An AI agent operating a real admin panel — it reads on its own, and
            waits for a human before anything it can&rsquo;t undo.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              href="/scenario"
              className="inline-flex items-center gap-2 rounded-full bg-action px-5 py-2.5 text-[14px] font-medium text-on-action transition-opacity hover:opacity-90"
            >
              Open the live demo <ArrowRight size={16} />
            </Link>
            <Link
              href="/tokens"
              className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-[14px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
            >
              Token system
            </Link>
          </div>
        </div>

        <div>
          <div className="hidden sm:block">
            <AppShot />
          </div>
          <div className="sm:hidden">
            <AppShotMobile />
          </div>
          <p className="mt-3 text-center text-[11px] text-ink-3">
            Frozen at the approval gate. The live version runs a real local model.
          </p>
        </div>
      </section>

      {/* ── Claims strip ─────────────────────────────────────────────────── */}
      <section className="grid gap-px border-t border-line sm:grid-cols-3">
        {CLAIMS.map((c) => (
          <div key={c.title} className="py-6 sm:px-6 sm:first:pl-0 sm:not-first:border-l sm:not-first:border-line">
            <h3 className="text-[14px] font-medium text-ink">{c.title}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{c.body}</p>
          </div>
        ))}
      </section>

      {/* ── Catalog as an index ──────────────────────────────────────────── */}
      <section className="mt-20 pb-16">
        <h2 className="text-[11px] uppercase tracking-[0.11em] text-ink-3">Interface patterns</h2>
        <ul className="mt-4 border-t border-line">
          {CATALOG.map((p) => (
            <li
              key={p.n}
              className="flex items-baseline gap-4 border-b border-line py-4 sm:gap-6"
            >
              <span className="font-mono text-[12px] text-ink-3">{p.n}</span>
              <div className="min-w-0 flex-1">
                <span className="text-[15px] font-medium text-ink">{p.name}</span>
                <p className="mt-0.5 text-[13px] leading-relaxed text-ink-2">{p.line}</p>
              </div>
              <span
                className={
                  p.wedge
                    ? "flex-none text-[11px] font-medium text-ink"
                    : "flex-none text-[11px] text-ink-3"
                }
              >
                {p.count}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-line py-8 text-[12px] text-ink-3">
        A portfolio piece. Northbase and its catalog are entirely fictional.
      </footer>
    </main>
  );
}
