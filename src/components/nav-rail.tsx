import { CreditCard, Package, Settings } from "lucide-react";
import { cn } from "@/lib/cn";

const ITEMS = [
  { icon: Package, label: "Products", active: true },
  { icon: CreditCard, label: "Billing", active: false },
  { icon: Settings, label: "Settings", active: false },
];

/** Fictional nav rail. Products is the only live view this iteration. */
export function NavRail() {
  return (
    <nav
      aria-label="Northbase sections"
      className="hidden w-14 flex-col items-center gap-1 border-r border-line bg-page py-4 lg:flex"
    >
      {ITEMS.map(({ icon: Icon, label, active }) => (
        <span
          key={label}
          title={label}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex size-9 items-center justify-center rounded-lg text-ink-3",
            active && "bg-action text-on-action",
          )}
        >
          <Icon size={17} strokeWidth={active ? 2 : 1.75} />
        </span>
      ))}
    </nav>
  );
}
