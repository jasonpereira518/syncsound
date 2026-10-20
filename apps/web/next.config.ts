import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@syncsound/protocol', '@syncsound/audio-core'],
  reactStrictMode: true,
  agentRules: false,
};
export default config;
