FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HALO_STATE_DIR=/state/private \
    HOME=/home/halo

RUN groupadd --gid 10001 halo \
    && useradd --uid 10001 --gid halo --create-home --home-dir /home/halo halo \
    && mkdir -p /app/tools /state/private \
    && chown -R halo:halo /state \
    && chmod 0700 /state /state/private

# Development tooling only: Claude Code CLI plus this project's own guard-hook
# plugin (songjiun10-collab/hook) and thinking-skill pack
# (songjiun10-collab/Senior-thinking-skills), so an assistant working inside
# this container gets the same safety hooks and skill routing as on the host.
# The gateway process itself (see CMD at the end of this file) never touches
# any of this. Unlike the rest of this image, this step reaches the network
# during build (npm registry, GitHub) — a deliberate, scoped exception to the
# no-network-build rule documented in docs/DOCKER.ko.md, not the default.
# UNVERIFIED: written and reasoned through without a local Docker daemon
# available to actually run `docker build` against — see docs/DOCKER.ko.md
# before relying on this layer; the exact `claude plugin` CLI flags may need
# adjusting once someone with Docker actually builds this image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code \
    && pip install --no-cache-dir mcp==2.0.0 pyotp==2.10.0 gunicorn==26.2.0
USER halo:halo
RUN yes | claude plugin marketplace add songjiun10-collab/hook \
    && yes | claude plugin install hook@hook \
    && git clone --depth 1 https://github.com/songjiun10-collab/Senior-thinking-skills.git \
        /home/halo/.claude/skills
USER root:root

WORKDIR /app
COPY halo/ ./halo/
COPY tools/docker_smoke.py ./tools/docker_smoke.py
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "halo.dev_server", "--host", "0.0.0.0", "--port", "8080"]
