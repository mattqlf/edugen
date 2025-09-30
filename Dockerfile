FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --omit=dev

# Copy app files
COPY index.html ./
COPY share.html ./
COPY server.js ./

EXPOSE 3000
USER node
CMD ["node", "server.js"]
