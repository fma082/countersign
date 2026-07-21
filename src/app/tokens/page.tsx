import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const NEUTRALS = [
  ["n0", "#FFFFFF"], ["n50", "#F6F5F2"], ["n100", "#EDEBE6"], ["n200", "#DEDBD3"],
  ["n400", "#A3A099"], ["n600", "#6B6862"], ["n700", "#3A3835"], ["n800", "#2A2926"],
  ["n900", "#1C1B18"], ["n975", "#0C0C0B"],
] as const;

const STATE = [
  ["red-600", "#B4443C"], ["red-400", "#D98A82"],
  ["green-600", "#4A7A56"], ["green-400", "#8FB89A"],
] as const;

// [semantic token, utility, light primitive, dark primitive]
const SURFACES = [
  ["surface/page", "bg-page", "n50", "n975"],
  ["surface/panel", "bg-panel", "n0", "n900"],
  ["surface/sub", "bg-sub", "n100", "n800"],
  ["surface/input", "bg-field", "n50", "n800"],
] as const;

const TEXT = [
  ["text/primary", "text-ink", "n900", "n50"],
  ["text/secondary", "text-ink-2", "n600", "n400"],
  ["text/tertiary", "text-ink-3", "n400", "n600"],
  ["text/error", "text-error", "red-600", "red-400"],
  ["text/success", "text-success", "green-600", "green-400"],
] as const;

const STRUCTURE = [
  ["interactive/primary", "bg-action", "n900", "n0"],
  ["border/default", "border-line", "n200", "n700"],
  ["border/strong", "border-line-strong", "n400", "n600"],
] as const;

export default function TokensPage() {
  return (
    <main className="mx-auto max-w-3xl px-8 py-12">
      <div className="mb-10 flex items-center justify-between">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[12px] text-ink-3 transition-colors hover:text-ink"
        >
          <ArrowLeft size={13} /> Home
        </Link>
        <ThemeToggle />
      </div>

      <h1 className="text-2xl font-medium tracking-[-0.02em] text-ink">Token system</h1>
      <p className="mt-3 max-w-xl text-[14px] leading-relaxed text-ink-2">
        Monochrome, no brand color. Two layers: primitives (constants, invariant
        across modes) and semantic tokens (alias primitives, flip between light
        and dark). Toggle the theme — every semantic swatch inverts at runtime,
        because the utilities point at CSS variables, not baked values.
      </p>

      <Section title="Primitives — warm neutral scale">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {NEUTRALS.map(([name, hex]) => (
            <Swatch key={name} name={name} hex={hex} />
          ))}
        </div>
      </Section>

      <Section title="Primitives — state (error / success only)">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {STATE.map(([name, hex]) => (
            <Swatch key={name} name={name} hex={hex} />
          ))}
        </div>
      </Section>

      <Section title="Semantic — surfaces">
        <TokenTable rows={SURFACES} render={(u) => <div className={`size-8 rounded-md border border-line ${u}`} />} />
      </Section>

      <Section title="Semantic — text">
        <TokenTable rows={TEXT} render={(u) => <span className={`text-[15px] font-medium ${u}`}>Aa</span>} />
      </Section>

      <Section title="Semantic — interactive & borders">
        <TokenTable
          rows={STRUCTURE}
          render={(u) =>
            u.startsWith("bg") ? (
              <div className={`size-8 rounded-md ${u}`} />
            ) : (
              <div className={`size-8 rounded-md border-2 ${u}`} />
            )
          }
        />
      </Section>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="mb-3 text-[11px] uppercase tracking-[0.09em] text-ink-3">{title}</h2>
      {children}
    </section>
  );
}

function Swatch({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="rounded-token border border-line p-2">
      <div className="h-10 w-full rounded-md border border-line" style={{ background: hex }} />
      <p className="mt-1.5 font-mono text-[11px] text-ink">{name}</p>
      <p className="font-mono text-[10px] text-ink-3">{hex}</p>
    </div>
  );
}

function TokenTable({
  rows,
  render,
}: {
  rows: readonly (readonly [string, string, string, string])[];
  render: (utility: string) => React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-token border border-line">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-line text-ink-3">
            <th className="px-3 py-2 text-left font-normal">Preview</th>
            <th className="px-3 py-2 text-left font-normal">Semantic</th>
            <th className="px-3 py-2 text-left font-normal">Utility</th>
            <th className="px-3 py-2 text-left font-normal">Light</th>
            <th className="px-3 py-2 text-left font-normal">Dark</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([token, utility, light, dark]) => (
            <tr key={token} className="border-b border-line last:border-0">
              <td className="px-3 py-2">{render(utility)}</td>
              <td className="px-3 py-2 font-mono text-ink">{token}</td>
              <td className="px-3 py-2 font-mono text-ink-2">{utility}</td>
              <td className="px-3 py-2 font-mono text-ink-3">{light}</td>
              <td className="px-3 py-2 font-mono text-ink-3">{dark}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
