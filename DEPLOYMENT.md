# OAuth Server Deployment Guide

This server handles HubSpot OAuth flow and redirects users to the HubSpot settings page after authentication.

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

- `HUBSPOT_CLIENT_ID` - Your HubSpot app's client ID
- `HUBSPOT_CLIENT_SECRET` - Your HubSpot app's client secret
- `HUBSPOT_REDIRECT_URI` - The callback URL (must match HubSpot app settings)
- `HUBSPOT_SCOPES` - Space-separated list of scopes (default: "oauth")
- `HUBSPOT_APP_ID` - Your HubSpot app ID (default: "27714105")
- `PORT` - Server port (default: 3000)

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file with your credentials

3. Run the server:
```bash
npm start
```

4. Access the install endpoint:
```
http://localhost:3000/install
```

## Docker Deployment

1. Build the image:
```bash
docker build -t hubspot-oauth-server .
```

2. Run the container:
```bash
docker run -d \
  -p 3000:3000 \
  -e HUBSPOT_CLIENT_ID=your-client-id \
  -e HUBSPOT_CLIENT_SECRET=your-client-secret \
  -e HUBSPOT_REDIRECT_URI=https://your-domain.com/oauth/callback \
  -e HUBSPOT_APP_ID=27714105 \
  --name hubspot-oauth \
  hubspot-oauth-server
```

Or use a `.env` file:
```bash
docker run -d \
  -p 3000:3000 \
  --env-file .env \
  --name hubspot-oauth \
  hubspot-oauth-server
```

## API Endpoints

- `GET /` - Health check
- `GET /install` - Initiates OAuth flow (redirects to HubSpot)
- `GET /oauth/callback` - OAuth callback handler (redirects to HubSpot settings)
- `GET /refresh?hub_id=<id>` - Refresh access token for a specific hub

## Post-Authentication Redirect

After successful OAuth authentication, users are redirected to:
```
https://app.hubspot.com/integrations-settings/{portalId}/installed/framework/{appId}/general-settings
```

Where:
- `portalId` is dynamically extracted from the OAuth token response
- `appId` is set via `HUBSPOT_APP_ID` environment variable (default: "27714105")
