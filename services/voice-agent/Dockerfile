# ClickAI voice agent (LiveKit Agents worker). Build from the REPOSITORY ROOT:
#   docker build -f services/voice-agent/Dockerfile -t clickai-voice-agent:<git-sha> .
# The agent reuses two pure modules from the app (src/lib/voice-intent-lexicon.ts,
# src/lib/voice-languages.ts), copied below at the same relative paths.
FROM node:22.11-bookworm-slim AS deps
WORKDIR /app/services/voice-agent
COPY services/voice-agent/package.json services/voice-agent/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
# Bake the turn-detector model into the image (needs huggingface.co at build time),
# so a container never downloads models on its first call.
RUN npx livekit-agents download-files

FROM node:22.11-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /root/.cache /home/node/.cache
COPY --from=deps /app/services/voice-agent/node_modules services/voice-agent/node_modules
COPY services/voice-agent/package.json services/voice-agent/tsconfig.json services/voice-agent/
COPY services/voice-agent/src services/voice-agent/src
COPY src/lib/voice-intent-lexicon.ts src/lib/voice-languages.ts src/lib/
RUN chown -R node:node /home/node/.cache
USER node
WORKDIR /app/services/voice-agent
EXPOSE 8081
# LiveKit's built-in health server: 200 when connected to LiveKit and the inference process runs.
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8081)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 'start' = production mode: SIGTERM drains (no new calls, active calls finish) before exit.
CMD ["node", "--experimental-strip-types", "src/worker.ts", "start"]
