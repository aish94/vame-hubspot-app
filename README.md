# vame-hubspot-app

This project was bootstrapped with [Create Wix App](https://www.npmjs.com/package/@wix/create-app).  
Read more about it in the [Wix CLI for Apps
 documentation](https://dev.wix.com/docs/build-apps/developer-tools/cli/get-started/about-the-wix-cli-for-apps).

## Setup 🔧

##### Install dependencies:

```console
npm install
```

## Available Scripts

In the project directory, you can run:

```console
npm run dev
```

## HubSpot OAuth Flow

This app now includes a local OAuth callback server used by the Wix dashboard modal.

1. Register the callback URL in HubSpot as:
   `http://localhost:3001/auth/hubspot/callback`
2. Set the environment variables before starting the server:
   - `HUBSPOT_CLIENT_ID`
   - `HUBSPOT_CLIENT_SECRET`
   - `HUBSPOT_SCOPES` (must exactly match the scopes configured in your HubSpot app)
   - `HUBSPOT_REDIRECT_URI=http://localhost:3001/auth/hubspot/callback`
3. Run the OAuth server:

```console
npm run serve:oauth
```

4. Then click **Connect HubSpot** in the Wix modal.

The server handles the callback, exchanges the OAuth code for a HubSpot access token, and displays the token response.
