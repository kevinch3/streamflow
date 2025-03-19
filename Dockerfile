FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy everything from /app (including config and index.js)
COPY app/ ./app/
COPY html/ /var/www/html/
COPY hls/ /var/www/hls/

WORKDIR /app/app
RUN npm install

EXPOSE 1935 80

CMD ["node", "index.js"]
