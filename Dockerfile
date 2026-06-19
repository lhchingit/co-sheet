# syntax=docker/dockerfile:1

###############################################################################
# Stage 1 — install production dependencies in isolation for better caching.
###############################################################################
FROM node:24-alpine AS deps
WORKDIR /app

# Copy only the manifests first so `npm ci` is cached unless they change.
COPY package.json package-lock.json ./

# Install exactly the locked production dependencies (no devDependencies).
RUN npm ci --omit=dev


###############################################################################
# Stage 2 — build the Tailwind CSS with the (dev-only) Tailwind CLI so the image
# always ships freshly compiled stylesheets, independent of the committed copies.
###############################################################################
FROM node:24-alpine AS assets
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# Only the inputs the Tailwind content scan needs.
COPY tailwind ./tailwind
COPY private ./private
COPY public ./public
RUN npm run build:css


###############################################################################
# Stage 3 — runtime image.
###############################################################################
FROM node:24-alpine AS runtime
WORKDIR /app

# Sensible production defaults; override via compose / -e at runtime.
ENV NODE_ENV=production \
    PORT=3000

# Bring in the already-installed dependencies.
COPY --from=deps /app/node_modules ./node_modules

# Copy the application source. .dockerignore keeps secrets, mockups and
# local persistence files out of the image.
COPY . .

# Overwrite the committed stylesheets with the freshly compiled ones so the running
# image never serves a stale build.
COPY --from=assets /app/public/styles-editor.css /app/public/styles-drive.css /app/public/styles-login.css ./public/

# Run as the unprivileged user that ships with the node image.
USER node

EXPOSE 3000

# Lightweight healthcheck against the unauthenticated login page.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/login" || exit 1

CMD ["node", "server.js"]
