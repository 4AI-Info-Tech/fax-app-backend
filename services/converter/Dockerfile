FROM debian:bookworm-slim

WORKDIR /app

# Install only LibreOffice (for Office-to-PDF) and minimal dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    unzip \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    fonts-liberation \
    fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# Install Bun runtime
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then \
    curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.2.2/bun-linux-aarch64.zip; \
    else \
    curl -fsSL -o bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.2.2/bun-linux-x64-baseline.zip; \
    fi && \
    unzip -j bun.zip -d /usr/local/bin && \
    rm bun.zip && \
    chmod +x /usr/local/bin/bun

# Create a minimal ConvertX-compatible conversion server
# This lightweight server accepts file uploads and uses LibreOffice for conversion
COPY engine/server.js /app/server.js

EXPOSE 3000/tcp

ENV NODE_ENV=production
ENTRYPOINT ["bun", "run", "/app/server.js"]