import type { NextConfig } from "next";

// web/.env is a symlink to the repo-root .env, shared with Foundry, so Next loads it natively in
// every process. Secrets stay server-side: only the values below are inlined into the browser
// bundle, and all of them are public.
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_WORLD_APP_ID: process.env.WORLD_APP_ID,
    NEXT_PUBLIC_WORLD_ACTION: process.env.WORLD_ACTION,
    NEXT_PUBLIC_WORLD_ENVIRONMENT: process.env.WORLD_ENVIRONMENT,
  },
};

export default nextConfig;
