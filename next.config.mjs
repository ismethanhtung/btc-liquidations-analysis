import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @type {import('next').NextConfig} */
const baseConfig = {
  experimental: {
    typedRoutes: false
  }
};

export default function nextConfig(phase) {
  return {
    ...baseConfig,
    // Keep dev/build artifacts separated to avoid chunk mismatch when running
    // `next dev` and `next build` in the same workspace.
    ...(phase === PHASE_DEVELOPMENT_SERVER ? { distDir: ".next-dev" } : {})
  };
}
