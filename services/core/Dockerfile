FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY services ./services
COPY tsconfig*.json ./
RUN npm ci
RUN npm run prisma:generate
RUN npm run build
RUN npm pkg set main=dist/index.js types=dist/index.d.ts -w @myclient/common -w @myclient/contracts -w @myclient/database
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/services/core/package.json ./services/core/package.json
COPY --from=build --chown=node:node /app/services/core/dist ./services/core/dist
USER node
CMD ["node", "services/core/dist/main.js"]
