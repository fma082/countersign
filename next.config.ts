import type { NextConfig } from "next";

/**
 * Hygiene note: `next build` and `next dev` must NOT share a `.next` dir.
 * A mixed cache pushes Turbopack into a phantom recompilation loop.
 * We split distDir by environment. Both dirs are gitignored.
 */
const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === "production" ? ".next-build" : ".next-dev",
};

export default nextConfig;
