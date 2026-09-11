FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

RUN mkdir -p logs

EXPOSE 4000

CMD ["node", "src/index.js"]
