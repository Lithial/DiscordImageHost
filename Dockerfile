# syntax=docker/dockerfile:1

# ---- build stage: install all deps and compile TypeScript ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps + compiled output only ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Default to the HTTP transport so the container is a long-lived MCP service.
ENV MCP_TRANSPORT=http
ENV PORT=3939
EXPOSE 3939

# Run as the unprivileged node user (uid 1000) so it can read host files that are
# bind-mounted in (the typical host user is also uid 1000).
USER node
CMD ["node", "dist/index.js"]
