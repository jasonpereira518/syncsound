import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@syncsound/protocol', '@syncsound/audio-core'],
  reactStrictMode: true,
  agentRules: false,
  // `SERVER_PORT=8788 pnpm dev` moves the room server; the browser derives <page host>:<port> from this
  env: { NEXT_PUBLIC_SERVER_PORT: process.env.NEXT_PUBLIC_SERVER_PORT ?? process.env.SERVER_PORT ?? '' },
};
export default config;
