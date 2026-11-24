# Stage 1: Build Pro Studio Dark React frontend
FROM node:22-slim AS web-builder
WORKDIR /repo
COPY packages/edl-schema ./packages/edl-schema
COPY apps/web/package.json apps/web/package-lock.json ./apps/web/
RUN cd apps/web && npm ci
COPY apps/web ./apps/web
RUN cd apps/web && npm run build

# Stage 2: Hardened Python 3.12 + FFmpeg + libass runtime
FROM python:3.12-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash cutflow

WORKDIR /app
COPY packages/edl-schema ./packages/edl-schema
COPY apps/api ./apps/api
COPY --from=web-builder /repo/apps/web/dist ./apps/web/dist

RUN pip install --no-cache-dir "./apps/api" \
    && mkdir -p /data /inbox \
    && chown -R cutflow:cutflow /app /data /inbox

USER cutflow
WORKDIR /app/apps/api
ENV CUTFLOW_HOME=/data \
    CUTFLOW_INBOX_DIR=/inbox \
    CUTFLOW_ALLOW_CONTAINER_BIND=1

EXPOSE 8010
CMD ["cutflow", "serve", "--host", "0.0.0.0", "--port", "8010"]
