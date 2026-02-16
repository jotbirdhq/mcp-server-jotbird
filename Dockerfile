FROM node:18-alpine AS builder
WORKDIR /app

# Install dependencies (including dev deps for build)
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app

# Install only production dependencies
COPY package.json package-lock.json ./
ENV NODE_ENV=production
RUN npm ci --only=production

# Copy built output
COPY --from=builder /app/dist ./dist

USER node

ENTRYPOINT ["node", "dist/index.js"]
