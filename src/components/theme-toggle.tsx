"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/cn";

/** Runtime light/dark swap. The tokens invert via CSS variables — no reload. */
export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("cs-theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light" : "Switch to dark"}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border border-line px-3 py-1.5 text-xs text-ink-2 transition-colors hover:border-line-strong hover:text-ink",
        className,
      )}
    >
      {dark ? <Sun size={13} /> : <Moon size={13} />}
      <span>{dark ? "Light" : "Dark"}</span>
    </button>
  );
}
