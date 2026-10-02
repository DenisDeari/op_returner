# phoenixd — the Lightning node SatWire takes Lightning payments through.
#
# The JVM build, NOT the native linux-arm64 one. The native binary dies with SIGILL
# (exit 132, "illegal instruction") on this Raspberry Pi 4 a few seconds after start: its
# Cortex-A72 has no ARMv8 crypto or LSE-atomics extensions (/proc/cpuinfo features:
# fp asimd evtstrm crc32 cpuid), and the native build assumes them. Found on 2026-10-02
# on the first real start. The JVM detects CPU features at runtime and runs anywhere.
#
# The download is pinned to the SHA-256 that ACINQ's signed SHA256SUMS.asc lists for it.
# That file was checked on 2026-10-02 with `gpg -d` against release key
# 6AA4 5A4C 209A 2D30 64CF  66BE E434 ED29 2E85 643A, fetched independently from
# acinq.co/pgp/padioupm.asc and from the maintainer's GitHub account, and both copies
# matched. Upgrading means repeating that check and changing BOTH lines below.
ARG PHOENIXD_VERSION=0.9.2
ARG PHOENIXD_SHA256=f1761c3e27ea0b7b9005d08dbafe812824836e97c9ab0cf554dbee3e7e4668a9

FROM debian:trixie-slim AS fetch
ARG PHOENIXD_VERSION
ARG PHOENIXD_SHA256
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /fetch
RUN curl -fsSL -o phoenixd.zip \
        "https://github.com/ACINQ/phoenixd/releases/download/v${PHOENIXD_VERSION}/phoenixd-${PHOENIXD_VERSION}-jvm.zip" \
    && echo "${PHOENIXD_SHA256}  phoenixd.zip" | sha256sum -c - \
    && unzip -q phoenixd.zip \
    && mv "phoenixd-${PHOENIXD_VERSION}-jvm" app

FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 phoenix \
    && useradd --system --uid 1000 --gid phoenix --home /phoenix --create-home phoenix
COPY --from=fetch --chown=phoenix:phoenix /fetch/app /phoenix/app
# The same paths the native image had, so nothing that calls them has to change.
RUN ln -s /phoenix/app/bin/phoenixd /phoenix/phoenixd && ln -s /phoenix/app/bin/phoenix-cli /phoenix/phoenix-cli
USER phoenix
WORKDIR /phoenix
# A Pi has 4 GB and other tenants; the JVM would otherwise size its heap to a quarter of it.
ENV JAVA_OPTS="-Xmx320m -XX:+UseSerialGC"
# The seed, the channel state and phoenix.conf all live here. Losing this volume without
# a backup of the seed loses the Lightning balance.
RUN mkdir -p /phoenix/.phoenix
VOLUME ["/phoenix/.phoenix"]
EXPOSE 9740
# Bound to all interfaces INSIDE the container so the webapp can reach it over the
# compose network. No port is published to the host or the internet (docker-compose.yml).
ENTRYPOINT ["/phoenix/app/bin/phoenixd", "--agree-to-terms-of-service", "--http-bind-ip", "0.0.0.0"]
