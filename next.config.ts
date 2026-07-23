import type { NextConfig } from "next";

/**
 * Hygiene note: `next dev` and `next build` must NOT share a `.next` dir.
 * A mixed cache pushes Turbopack into a phantom recompilation loop.
 *
 * Only `next dev` diverges — it writes to `.next-dev`. Every build (local AND
 * Vercel) uses the default `.next`, which is exactly where Vercel looks for the
 * output. Keying on the command (via NODE_ENV: `development` = `next dev`) keeps
 * dev and build from colliding locally without special-casing the host — an
 * earlier `production ? ".next-build"` split broke Vercel, which fails when the
 * output isn't at `.next`.
 */
const nextConfig: NextConfig = {
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
};

export default nextConfig;
