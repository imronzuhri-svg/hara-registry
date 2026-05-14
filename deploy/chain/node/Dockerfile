FROM hyperledger/besu:26.4.0

USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates bash && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /opt/besu/data && \
    chown -R besu:besu /opt/besu/data

# Scripts are bind-mounted at runtime via docker-compose; nothing copied here.
# Stay root in L0 dev for write perms to /opt/besu/data on bind volumes;
# production will tighten this (run as besu UID, pre-create volumes).
