# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY services/stt-gateway/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/stt-gateway/*.mjs ./
USER node
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]
