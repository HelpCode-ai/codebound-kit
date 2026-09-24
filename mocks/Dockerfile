FROM node:22-alpine
WORKDIR /kit
COPY data.mjs reference.mjs server.mjs ./mocks/
# The volume inherits this ownership on first mount, so the unprivileged user
# can persist the registered credentials across restarts.
RUN mkdir -p /data && chown node:node /data
ENV DATA_DIR=/data
USER node
CMD ["node", "mocks/server.mjs"]
