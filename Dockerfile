FROM node:22-alpine

WORKDIR /app

COPY app/ ./app/
COPY html/ /app/html/

WORKDIR /app/app
RUN npm install

EXPOSE 80

USER node
CMD ["node", "index.js"]
