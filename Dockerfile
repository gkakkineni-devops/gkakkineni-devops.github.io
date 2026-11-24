# Serves the built site from an unprivileged nginx (runs as uid 101, listens on 8080).
# Build the site first:  python3 scripts/build.py --offline
FROM nginxinc/nginx-unprivileged:stable-alpine

LABEL org.opencontainers.image.title="gopala-portfolio" \
      org.opencontainers.image.description="Personal portfolio site served by nginx" \
      org.opencontainers.image.licenses="LicenseRef-All-Rights-Reserved"

# The base image shipped brotli-libs 1.2.0-r1 and nginx 1.30.6-r1, which have CRITICAL CVEs
# fixed in brotli-libs 1.2.1-r0 and nginx 1.30.7. This upgrades only those packages.
# The image's nginx comes from nginx.org, not from Alpine, so the nginx upgrade has to come from
# there too (-X). The nginx modules are tied to the nginx version, so they go in the same step.
# Once the base image is rebuilt this does nothing, so it is safe to delete.
USER root
# hadolint ignore=DL3018
RUN apk add --no-cache --upgrade \
      -X "https://nginx.org/packages/alpine/v$(grep -Eo '^[0-9]+\.[0-9]+' /etc/alpine-release)/main" \
      "brotli-libs>=1.2.1" "nginx>=1.30.7" \
      nginx-module-geoip nginx-module-image-filter nginx-module-njs nginx-module-xslt

COPY --chown=101:101 deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 dist/ /usr/share/nginx/html/

USER 101
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:8080/healthz || exit 1
