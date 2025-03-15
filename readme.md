# StreamFlow Quickstart

A minimal RTMP-to-HLS setup using Podman on Windows (WSL2).

## Features

> RTMP ingest

> HLS playback

> Basic HTML page

> Prerequisites

> Windows with WSL2 installed

> Podman & Podman-Compose (optional)

> OBS Studio (or another RTMP broadcaster)

## Directory Structure

>streamflow  
>├── Dockerfile (nginx.dockerfile)  
>├── nginx.conf  
>├── html/  
>│   └── index.html  
>├── hls/ (empty folder for HLS segments)  
>└── README.md (this file)  

Step 1: Write nginx.conf

>worker_processes auto;
>
>events {
>    worker_connections 1024;
>}
>rtmp {
>    server {  
>
>        listen 1935;
>        chunk_size 4096;
>        application stream {
>            live on;
>            record off;
>            hls on;
>            hls_path /var/www/hls;
>            hls_fragment 3s;
>            hls_playlist_length 60s;
>        }
>    }
>}
>
>http {
>    server {
>        listen 80;
>
>        location / {
>            root /var/www/html;
>            index index.html;
>        }
>
>        location /hls {
>            types {
>                application/vnd.apple.mpegurl m3u8;
>                video/mp2t ts;
>            }
>            alias /var/www/hls;
>            add_header Cache-Control no-cache;
>            add_header Access-Control-Allow-Origin *;
>        }
>    }
>}

Step 2: Set up Dockerfile (nginx.dockerfile)

>FROM alfg/nginx-rtmp:latest

# Rename existing config if present
RUN mv /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak || true

# Copy in our custom config
COPY nginx.conf /etc/nginx/nginx.conf

# Create needed dirs
RUN mkdir -p /var/www/hls /var/www/html

EXPOSE 1935 80

# Rely on base image's startup. (We force our config)
CMD ["nginx", "-c", "/etc/nginx/nginx.conf", "-g", "daemon off;"]

Step 3: Add an index.html (Optional, for quick testing)

File: html/index.html

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>StreamFlow Quick Test</title>
</head>
<body>
  <h1>Welcome to StreamFlow!</h1>
  <p>
    RTMP Ingest: <code>rtmp://localhost:1935/stream</code><br>
    HLS Playback: <code>http://localhost/hls/&lt;your-stream-key&gt;.m3u8</code>
  </p>
  <video width="640" height="360" controls autoplay>
    <source src="/hls/test.m3u8" type="application/vnd.apple.mpegurl">
    Your browser does not support HLS streaming.
  </video>
</body>
</html>

Step 4: Build & Run Container

Open PowerShell in your project folder:

>podman build -t my-nginx-rtmp -f nginx.dockerfile .

>podman run -d `  
>  --name streamflow `  
>  -p 1935:1935 `  
>  -p 80:80 `  
>  -v "${PWD}/html:/var/www/html:Z" `  
>  -v "${PWD}/hls:/var/www/hls:Z" `  
>  my-nginx-rtmp

Note: If you get volume-mount issues, use absolute WSL paths like:
/mnt/c/Users/YourUser/Documents/Dev/streamflow/...

Step 5: Test Streaming in OBS

Settings → Stream

Service: Custom

>Server: rtmp://localhost:1935/stream

Stream Key: e.g. test

Click Start Streaming.

You should see logs in podman logs streamflow indicating RTMP connection.

Step 6: View HLS

Open your browser:

http://localhost/hls/test.m3u8

If you have an index.html with a video tag referencing test.m3u8, go to:

http://localhost

Troubleshooting

403 Forbidden: The container might be serving /www/static from the base config. Ensure you replaced the default nginx.conf.

Application not found: Double-check you used stream as the RTMP app name. Use rtmp://localhost:1935/stream.

No .m3u8 files: Possibly OBS failed to connect. Check logs with podman logs streamflow.