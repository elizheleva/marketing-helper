FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy server file
COPY server.js ./

# Environment variables (can be overridden)
ENV PORT=3000
ENV HUBSPOT_CLIENT_ID=""
ENV HUBSPOT_CLIENT_SECRET=""
ENV HUBSPOT_REDIRECT_URI=""
ENV HUBSPOT_SCOPES="oauth"
ENV HUBSPOT_APP_ID="27714105"

EXPOSE 3000

# Create directory for token storage (if needed)
RUN mkdir -p /app/data

CMD ["node", "server.js"]
