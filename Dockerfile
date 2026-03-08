FROM openclaw/openclaw:latest

# Copy config
COPY .openclaw.json /home/node/.openclaw.json

# Start gateway
CMD ["node", "openclaw.mjs", "gateway", "--allow-unconfigured"]
