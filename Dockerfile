FROM node:26-slim
WORKDIR /app
COPY . .
RUN npm ci --include=dev && npm run build -w apps/web
WORKDIR /app/apps/server
EXPOSE 8790
CMD ["npm", "run", "start:prod"]
