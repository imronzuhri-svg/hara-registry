FROM hyperledger/besu:26.4.0

USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl jq ca-certificates bash findutils && \
    rm -rf /var/lib/apt/lists/*

COPY init.sh /init.sh
RUN chmod +x /init.sh

WORKDIR /work
ENTRYPOINT ["/init.sh"]
