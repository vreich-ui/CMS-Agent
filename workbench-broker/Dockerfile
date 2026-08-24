# Small, non-root production image for the Conductor Workbench broker.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime deps only.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

# Non-root user (node:22-alpine ships a "node" user/group already).
USER node

EXPOSE 8787
CMD ["node", "dist/index.js"]
