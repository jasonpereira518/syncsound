# Multi-target image: `--target server` (WS room server) or `--target web` (Next.js frontend).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/audio-core/package.json packages/audio-core/
COPY packages/sim/package.json packages/sim/
RUN pnpm install --frozen-lockfile --filter @syncsound/server... --filter @syncsound/web...

FROM deps AS source
COPY . .

FROM source AS server
# ffprobe/ffmpeg: the server probes uploads for their length and splits long ones into segments (apps/server/src/media.ts)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
EXPOSE 8787
RUN pnpm demo && mkdir -p /data && cp -r apps/server/data/demo /data/demo
# declared after populating: build steps that touch a declared VOLUME path are discarded
VOLUME /data
CMD ["pnpm", "--filter", "@syncsound/server", "start"]

FROM source AS web-build
ARG NEXT_PUBLIC_SERVER_URL=
ARG NEXT_PUBLIC_SPOTIFY_CLIENT_ID=
ARG NEXT_PUBLIC_SPOTIFY_REDIRECT_URI=
ARG NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN=
ENV NEXT_PUBLIC_SERVER_URL=$NEXT_PUBLIC_SERVER_URL \
    NEXT_PUBLIC_SPOTIFY_CLIENT_ID=$NEXT_PUBLIC_SPOTIFY_CLIENT_ID \
    NEXT_PUBLIC_SPOTIFY_REDIRECT_URI=$NEXT_PUBLIC_SPOTIFY_REDIRECT_URI \
    NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN=$NEXT_PUBLIC_APPLE_MUSIC_DEVELOPER_TOKEN
RUN pnpm --filter @syncsound/web build

FROM web-build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@syncsound/web", "start"]
