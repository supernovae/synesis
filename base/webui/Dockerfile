# Synesis-themed Open WebUI
#
# Thin child image: injects synesis-theme.css as /static/custom.css.
# On startup, Open WebUI's config.py copies FRONTEND_BUILD_DIR/static/**
# into STATIC_DIR (the PVC), so the theme survives volume mounts.
#
# Build:  ./scripts/build-images.sh --only open-webui --push
# Pin:    bump the tag here when upgrading Open WebUI upstream.

FROM ghcr.io/open-webui/open-webui:v0.8.11

COPY synesis-theme.css /app/build/static/custom.css
