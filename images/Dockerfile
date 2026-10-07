# syntax=docker/dockerfile:1
# check=skip=InvalidDefaultArgInFrom
ARG UPSTREAM_VERSION

FROM ghcr.io/jitsi/prosody:${UPSTREAM_VERSION} AS prosody
ENV MEET_RUN_CONFIG=/run/prosody/config
COPY images/s6/ /etc/s6-overlay/
COPY prosody/plugins/ /prosody-plugins/
COPY prosody/conf.d/ /meet/defaults/config/conf.d/

FROM ghcr.io/jitsi/web:${UPSTREAM_VERSION} AS web
ENV MEET_RUN_CONFIG=/run/web/config
COPY images/s6/ /etc/s6-overlay/
COPY web/s6/ /etc/s6-overlay/
COPY web/meet-transcription.js /defaults/meet-transcription.js
COPY web/custom-config.js /meet/defaults/config/
COPY web/nginx-custom/ /meet/defaults/config/nginx-custom/
COPY web/brand/ /meet/defaults/brand/
COPY web/landing/ /usr/share/jitsi-meet/static/landing/
USER root
RUN ln -s /run/meet/brand /usr/share/jitsi-meet/static/brand \
 && ln -sf /run/meet/brand/plugin.head.html /usr/share/jitsi-meet/plugin.head.html
USER s6

FROM ghcr.io/jitsi/jicofo:${UPSTREAM_VERSION} AS jicofo
ENV JICOFO_ENABLE_REST=1
COPY jicofo/s6/ /etc/s6-overlay/
COPY jicofo/meet-transcription.conf /defaults/meet-transcription.conf

FROM ghcr.io/jitsi/jvb:${UPSTREAM_VERSION} AS jvb

FROM ghcr.io/jitsi/jibri:${UPSTREAM_VERSION} AS jibri
ENV JIBRI_FINALIZE_RECORDING_SCRIPT_PATH=/usr/local/bin/meet-finalize.sh
COPY --chmod=755 services/recording-finalize/finalize.sh /usr/local/bin/meet-finalize.sh

FROM nginx:alpine AS app-proxy
COPY services/app-proxy/default.conf.template /etc/nginx/templates/default.conf.template
