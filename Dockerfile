FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY migrations ./migrations
COPY docs ./docs
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
