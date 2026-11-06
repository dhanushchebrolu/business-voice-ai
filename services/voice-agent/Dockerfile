# ClickAI voice agent (LiveKit Agents worker). Build from the REPOSITORY ROOT:
#   docker build -f services/voice-agent/Dockerfile -t clickai-voice-agent:<git-sha> .
# The agent reuses two pure modules from the app (src/lib/voice-intent-lexicon.ts,
# src/lib/voice-languages.ts), copied below at the same relative paths.
#
# Base image: the official Docker Hub node image, pinned by digest (multi-arch
# index, verified 2026-11-02 to be identical on Docker Hub and on
# mirror.gcr.io, Google's pull-through cache of Docker Hub). The digest pins
# the exact bytes, so the registry only changes where they are fetched from.
# If Docker Hub rate-limits the build host (429), build with
#   --build-arg BASE_REGISTRY=mirror.gcr.io/library
# Bump the tag and digest together, re-checking both registries.
ARG BASE_REGISTRY=docker.io/library
ARG NODE_IMAGE=node:22.11-bookworm-slim@sha256:f035ba7ffee18f67200e2eb8018e0f13c954ec16338f264940f701997e3c12da
# Set by BuildKit from the target platform (amd64 / arm64); selects the tini binary.
ARG TARGETARCH
# tini as PID 1 (an init process): Node as PID 1 ignores SIGTERM until it
# installs a handler, and does not reap orphans. tini forwards SIGTERM/SIGINT
# to the worker only (no -g: job processes with live calls are not signalled
# directly; the worker drains them). Static release binaries, pinned by
# SHA-256 (matching the release's published .sha256sum files, 2026-11-02).
FROM scratch AS tini-amd64
ADD --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee \
  https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64 /tini
FROM scratch AS tini-arm64
ADD --checksum=sha256:eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 \
  https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-arm64 /tini
FROM tini-${TARGETARCH} AS tini

FROM ${BASE_REGISTRY}/${NODE_IMAGE} AS deps
WORKDIR /app/services/voice-agent
COPY services/voice-agent/package.json services/voice-agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Bake the turn-detector model into the image (needs huggingface.co at build time),
# so a container never downloads models on its first call. prepare-model-cache
# makes the tokenizer loadable OFFLINE (see that file: @huggingface/transformers
# 4.2.0 looks up tokenizer_config.json under the "main" cache key).
COPY services/voice-agent/deploy/prepare-model-cache.mjs deploy/
RUN npx livekit-agents download-files && node deploy/prepare-model-cache.mjs

FROM ${BASE_REGISTRY}/${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=tini --chmod=0755 /tini /usr/local/bin/tini
WORKDIR /app
COPY --from=deps /root/.cache /home/node/.cache
COPY --from=deps /app/services/voice-agent/node_modules services/voice-agent/node_modules
COPY services/voice-agent/package.json services/voice-agent/tsconfig.json services/voice-agent/
COPY services/voice-agent/src services/voice-agent/src
COPY services/voice-agent/deploy/verify-models.mjs services/voice-agent/deploy/
COPY src/lib/voice-intent-lexicon.ts src/lib/voice-languages.ts src/lib/
RUN chown -R node:node /home/node/.cache
USER node
WORKDIR /app/services/voice-agent
# Fail the BUILD (not the first call) if the turn-detector files are not
# where the runtime looks for them, as this user, offline. Skip only for an
# image that will run with TURN_DETECTION=vad.
ARG VERIFY_TURN_DETECTOR=1
RUN if [ "$VERIFY_TURN_DETECTOR" = "1" ]; then node deploy/verify-models.mjs; fi
EXPOSE 8081
# LiveKit's built-in health server: 200 when connected to LiveKit and the inference process runs.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 'start' = production mode: SIGTERM drains (no new calls, active calls finish) before exit.
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["node", "--experimental-strip-types", "src/worker.ts", "start"]
