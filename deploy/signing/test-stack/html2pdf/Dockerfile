FROM node:20-bookworm-slim
WORKDIR /app
# node_modules se instala en el HOST (ver prepare.sh / README) y se copia acá:
# el build NO usa red (evita el proxy TLS). Reproducible y determinista.
COPY package.json ./
COPY node_modules ./node_modules
COPY server.js ./
EXPOSE 3000
CMD ["node", "server.js"]
