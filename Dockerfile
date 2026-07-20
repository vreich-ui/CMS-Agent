# Publishing Conductor execution plane — Cloud Run Job image (docs/platform/DIRECTION.md Phase 1).
# The repo has no emit step (Netlify bundles its own functions), so the image runs the TypeScript
# sources directly via tsx; the only "build" is installing production dependencies.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
USER node
# --import tsx registers the loader in-process (no child process), so Cloud Run's SIGTERM reaches
# the entrypoint directly and the graceful stop-after-current-node path works.
ENTRYPOINT ["node", "--import", "tsx", "src/agent/entrypoints/runConductorJobMain.ts"]
