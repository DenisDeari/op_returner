# phoenixd — the Lightning node SatWire takes Lightning payments through.
#
# The official release binary, not a source build: building phoenixd needs a JDK and
# Gradle and takes most of an hour on a Pi. The download is pinned to the SHA-256 that
# ACINQ's signed SHA256SUMS.asc lists for it. That file was checked on 2026-10-02 with
# `gpg -d` against release key 6AA4 5A4C 209A 2D30 64CF  66BE E434 ED29 2E85 643A,
# fetched independently from acinq.co/pgp/padioupm.asc and from the maintainer's GitHub
# account, and both copies matched. Upgrading means repeating that check and changing
# BOTH lines below, never just the version.
ARG PHOENIXD_VERSION=0.9.2
ARG PHOENIXD_SHA256=ee19b700c6f9ea727393aa11dc991610111a5b0e7c4de18249d6bdaa188ecfe9

FROM debian:trixie-slim AS fetch
ARG PHOENIXD_VERSION
ARG PHOENIXD_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
RUN curl -fsSL -o phoenixd.zip \
        "https://github.com/ACINQ/phoenixd/releases/download/v${PHOENIXD_VERSION}/phoenixd-${PHOENIXD_VERSION}-linux-arm64.zip" \
    && echo "${PHOENIXD_SHA256}  phoenixd.zip" | sha256sum -c - \
    && unzip -q phoenixd.zip \
    && mv "phoenixd-${PHOENIXD_VERSION}-linux-arm64" bin

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 phoenix \
    && useradd --system --uid 1000 --gid phoenix --home /phoenix --create-home phoenix
COPY --from=fetch --chown=phoenix:phoenix /fetch/bin/phoenixd /fetch/bin/phoenix-cli /phoenix/
USER phoenix
WORKDIR /phoenix
# The seed, the channel state and phoenix.conf all live here. Losing this volume without
# a backup of the seed loses the Lightning balance.
RUN mkdir -p /phoenix/.phoenix
VOLUME ["/phoenix/.phoenix"]
EXPOSE 9740
# Bound to all interfaces INSIDE the container so the webapp can reach it over the
# compose network. No port is published to the host or the internet (docker-compose.yml).
ENTRYPOINT ["/phoenix/phoenixd", "--agree-to-terms-of-service", "--http-bind-ip", "0.0.0.0"]
