# Serves the built site from an unprivileged nginx (runs as uid 101, listens on 8080).
# Build the site first:  python3 scripts/build.py --offline
FROM nginxinc/nginx-unprivileged:stable-alpine

LABEL org.opencontainers.image.title="gopala-portfolio" \
      org.opencontainers.image.description="Personal portfolio site served by nginx" \
      org.opencontainers.image.licenses="MIT"

# The base image shipped brotli-libs 1.2.0-r1, which has a CRITICAL CVE fixed in 1.2.1-r0.
# This upgrades only that package. Once the base image is rebuilt it does nothing, so it is safe to delete.
USER root
# hadolint ignore=DL3018
RUN apk add --no-cache --upgrade "brotli-libs>=1.2.1"

COPY --chown=101:101 deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 dist/ /usr/share/nginx/html/

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
