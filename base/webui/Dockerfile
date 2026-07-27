# Synesis-themed Open WebUI
#
# Child image: theme + a version-checked Synesis middleware patch.
# On startup, Open WebUI's config.py copies FRONTEND_BUILD_DIR/static/**
# into STATIC_DIR (the PVC), so the theme survives volume mounts.
#
# Build:  ./scripts/build-images.sh --only open-webui --push
# Pin:    bump the tag here when upgrading Open WebUI upstream.

FROM ghcr.io/open-webui/open-webui:v0.9.6

COPY overrides/capability_matrix.py /app/backend/open_webui/utils/capability_matrix.py
COPY overrides/sitecustomize.py /app/backend/sitecustomize.py
COPY overrides/patch_middleware.py /tmp/patch_middleware.py
RUN python /tmp/patch_middleware.py /app/backend/open_webui/utils/middleware.py \
    && rm /tmp/patch_middleware.py

COPY synesis-theme.css /app/build/static/custom.css

COPY synesis-fix-user-models.py /opt/synesis/synesis-fix-user-models.py
RUN chmod +x /opt/synesis/synesis-fix-user-models.py
