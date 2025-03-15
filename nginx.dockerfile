FROM alfg/nginx-rtmp:latest

# Remove (or rename) the existing main config
RUN mv /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak || true

# Copy in your custom config
COPY nginx.conf /etc/nginx/nginx.conf
RUN mkdir -p /var/www/hls /var/www/html

EXPOSE 1935 80

CMD ["nginx", "-c", "/etc/nginx/nginx.conf", "-g", "daemon off;"]
