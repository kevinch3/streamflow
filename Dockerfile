# Stage 1: build Tailwind CSS
FROM node:22-alpine AS builder

WORKDIR /build
COPY frontend/ ./frontend/
COPY html/ ./html/
RUN npm ci --prefix frontend && npm run build --prefix frontend

# Stage 2: runtime
FROM node:22-alpine

WORKDIR /app

COPY app/ ./app/
COPY html/ /app/html/
# Overlay the compiled CSS from the builder
COPY --from=builder /build/html/css/main.css /app/html/css/main.css

WORKDIR /app/app
RUN npm install

EXPOSE 80
USER node
CMD ["node", "index.js"]
