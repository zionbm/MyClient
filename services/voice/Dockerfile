FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages ./packages
COPY services ./services
COPY tsconfig*.json ./
RUN npm install
RUN npm run prisma:generate
CMD ["npm", "run", "start", "-w", "@myclient/voice"]
