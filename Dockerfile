FROM node:24.5.0-alpine
RUN apk add nut
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN chmod +x start.sh
CMD ["sh", "./start.sh"]
