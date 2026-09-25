FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HALO_STATE_DIR=/state/private

RUN groupadd --gid 10001 halo \
    && useradd --uid 10001 --gid halo --no-create-home halo \
    && mkdir -p /app/tools /state/private \
    && chown -R halo:halo /state \
    && chmod 0700 /state /state/private

WORKDIR /app
COPY halo/ ./halo/
COPY tools/docker_smoke.py ./tools/docker_smoke.py
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "halo.dev_server", "--host", "0.0.0.0", "--port", "8080"]
