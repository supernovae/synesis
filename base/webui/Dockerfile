# Synesis-themed Open WebUI
#
# Child image: theme + patched middleware (planner run_id in Open WebUI messages).
# On startup, Open WebUI's config.py copies FRONTEND_BUILD_DIR/static/**
# into STATIC_DIR (the PVC), so the theme survives volume mounts.
#
# Build:  ./scripts/build-images.sh --only open-webui --push
# Pin:    bump the tag here when upgrading Open WebUI upstream.

FROM ghcr.io/open-webui/open-webui:v0.8.12

COPY overrides/middleware.py /app/backend/open_webui/utils/middleware.py

COPY synesis-theme.css /app/build/static/custom.css
