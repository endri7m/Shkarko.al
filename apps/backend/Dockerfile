# Stage 1: Build source files
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package*.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/backend ./apps/backend

# Install dependencies and compile TypeScript
RUN npm ci
RUN npm run build -w packages/shared
RUN npm run build -w apps/backend

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package configurations
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/backend/package*.json ./apps/backend/

# Install only production dependencies
RUN npm ci --omit=dev --workspace=packages/shared --workspace=apps/backend

# Copy built outputs from compile stage
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/types.js ./packages/shared/
COPY --from=builder /app/packages/shared/types.d.ts ./packages/shared/
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist

EXPOSE 5000

ENV NODE_ENV=production
ENV PORT=5000

# Run API Server
CMD ["node", "apps/backend/dist/index.js"]
