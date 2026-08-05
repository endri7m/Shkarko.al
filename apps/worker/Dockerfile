# Stage 1: Build source files
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package*.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/worker ./apps/worker

# Install dependencies and compile TypeScript
RUN npm ci
RUN npm run build -w packages/shared
RUN npm run build -w apps/worker

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

# Install native ffmpeg, python3, and yt-dlp packages on Alpine
RUN apk add --no-cache ffmpeg python3 yt-dlp

# Copy package configurations
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/worker/package*.json ./apps/worker/

# Install only production dependencies
RUN npm ci --omit=dev --workspace=packages/shared --workspace=apps/worker

# Copy built outputs from compile stage
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/types.js ./packages/shared/
COPY --from=builder /app/packages/shared/types.d.ts ./packages/shared/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist

ENV NODE_ENV=production

# Run Transcoding Worker
CMD ["node", "apps/worker/dist/index.js"]
