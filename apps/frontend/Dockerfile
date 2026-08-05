# Stage 1: Build source files
FROM node:20-alpine AS builder

WORKDIR /app

# Copy root configurations
COPY package*.json tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/frontend ./apps/frontend

# Set public variables for compiler client ingestion (override with Railway URL at build time)
ARG NEXT_PUBLIC_API_URL=http://localhost:5000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# Install dependencies and compile Next.js
RUN npm ci
RUN npm run build -w packages/shared
RUN npm run build -w apps/frontend

# Stage 2: Production runner
FROM node:20-alpine AS runner

WORKDIR /app

# Copy package configurations
COPY package*.json ./
COPY packages/shared/package*.json ./packages/shared/
COPY apps/frontend/package*.json ./apps/frontend/

# Install only production dependencies
RUN npm ci --omit=dev --workspace=packages/shared --workspace=apps/frontend

# Copy built outputs and configs from compile stage
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/types.js ./packages/shared/
COPY --from=builder /app/packages/shared/types.d.ts ./packages/shared/
COPY --from=builder /app/apps/frontend/.next ./apps/frontend/.next
COPY --from=builder /app/apps/frontend/public ./apps/frontend/public
COPY --from=builder /app/apps/frontend/next.config.js ./apps/frontend/next.config.js

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Start Next.js server
CMD ["npx", "next", "start", "apps/frontend"]
