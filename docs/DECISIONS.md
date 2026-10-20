# Decisions

| # | Decision | Alternatives | Reason |
|---|----------|--------------|--------|
| 1 | TypeScript 6.0.x | TS 7 (native) | typescript-eslint 8.x peer range is `<6.1`. |
| 2 | Packages export `.ts` source, no build step | tsup/tsc builds per package | Fewer moving parts; Next `transpilePackages`, `tsx` for server, Vitest native TS. |
| 3 | Plain Node `http` + `ws` server | Bun, uWebSockets.js | `ws` is the prompt's default; runs everywhere incl. CI/Docker. |
| 4 | `pnpm -r --parallel` for `pnpm dev` | `concurrently` | No extra dependency. |
