FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["node", "src/bot.js"]
