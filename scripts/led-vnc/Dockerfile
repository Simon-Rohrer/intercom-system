# Bildschirm der LED-Wand-Steuerung im Browser: noVNC (Weboberfläche) + websockify (WebSocket → VNC).
# Läuft nur auf 127.0.0.1; erreichbar ist es ausschließlich über Caddy hinter der Admin-Anmeldung
# von JMS Control (Dienst „ledvnc“). Das VNC-Passwort fragt noVNC im Browser ab – es liegt nicht hier.
FROM python:3.12-alpine
ARG NOVNC_VERSION=1.5.0
ARG WEBSOCKIFY_VERSION=0.13.0
RUN pip install --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}" \
 && wget -qO- "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" | tar xz -C /opt \
 && mv "/opt/noVNC-${NOVNC_VERSION}" /opt/novnc \
 && cp /opt/novnc/vnc.html /opt/novnc/index.html
USER nobody
ENTRYPOINT ["websockify", "--web", "/opt/novnc"]
