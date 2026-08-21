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

# BUILD-TIME STARTUP GUARD. Import the entrypoint's ENTIRE module graph, in the image, with the
# exact loader the ENTRYPOINT uses — then throw the result away. Nothing is bound and nothing runs:
# the wrapper above is deliberately separate from its logic module precisely so the logic can be
# imported without the side effect, and this reuses that seam.
#
# WHY. On 2026-08-20 image mcp-service:49b1fc4 built green, pushed, deployed — and every revision
# from it failed with "The user-provided container failed to start and listen on the port defined by
# PORT=8080", having logged NOT ONE BYTE. The image before it, one inert 30-line commit earlier, ran
# fine. Same Dockerfile, byte-identical package-lock.json, identical revision config, and the same
# source booted in seconds outside the image. A build can therefore produce an image that cannot
# execute, and every signal upstream of the container still reads green.
#
# Zero logs is the tell: the failure is BEFORE the app, so the app can never report it, and Cloud Run
# only ever says "did not listen in time". A green build that ships a dead image costs a full deploy
# cycle plus the health-check deadline to discover, and gives nothing to read afterwards.
#
# So the build proves the image can load itself. `node --import tsx` failing, or any module in the
# graph failing to resolve, exits non-zero HERE — a red build naming the problem, instead of a green
# build and a silent revision. Verified against both failure modes before shipping.
#
# Runs as root, before USER node, deliberately: this checks that the image can LOAD, and a build-time
# permission difference would only add a second variable. Runtime already drops to node below.
RUN node --import tsx --input-type=module \
      -e "await import('./src/agent/entrypoints/runConductorJob.ts'); console.log('startup guard ok: conductor job graph loads')"

USER node
# --import tsx registers the loader in-process (no child process), so Cloud Run's SIGTERM reaches
# the entrypoint directly and the graceful stop-after-current-node path works.
ENTRYPOINT ["node", "--import", "tsx", "src/agent/entrypoints/runConductorJobMain.ts"]
