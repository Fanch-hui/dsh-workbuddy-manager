FROM ghcr.io/ithtelab/workbuddy-manager:2.11.10

USER root
WORKDIR /app
COPY workbuddy-manager.patch /tmp/dsh-workbuddy-manager.patch
RUN git apply --check /tmp/dsh-workbuddy-manager.patch && git apply /tmp/dsh-workbuddy-manager.patch
COPY --chmod=0644 dsh_bridge.py /app/server/routers/dsh_bridge.py
USER app
