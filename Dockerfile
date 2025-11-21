FROM node:24.5.0-alpine
RUN apt update && apt install -y nut-client
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN chmod +x start.sh
ENTRYPOINT [ "./start.sh" ]
