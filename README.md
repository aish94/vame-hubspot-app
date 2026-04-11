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

## Production Deployment (Railway)

This app is configured to deploy to [Railway](https://railway.app).

### Step 1: Push to GitHub
```bash
git add .
git commit -m "Deploy to Railway"
git push origin main
```

### Step 2: Create Railway Project
1. Go to [railway.app](https://railway.app)
2. Click **"Start a New Project"**
3. Select **"Deploy from GitHub"**
4. Authorize and select your repository
5. Click **"Deploy Now"**

### Step 3: Configure Environment Variables in Railway Dashboard
1. Click your project
2. Go to **"Variables"** tab
3. Set these variables:
   - `HUBSPOT_CLIENT_ID` - Your HubSpot app client ID
   - `HUBSPOT_CLIENT_SECRET` - Your HubSpot app client secret
   - `HUBSPOT_SCOPES` - `crm.objects.contacts.read crm.objects.contacts.write oauth`
   - `HUBSPOT_REDIRECT_URI` - `https://YOUR_RAILWAY_DOMAIN/auth/hubspot/callback` (use your Railway domain)
   - `PORT` - `3001`
   - `VITE_API_URL` - `https://YOUR_RAILWAY_DOMAIN` (your Railway domain, used by frontend)

### Step 4: Get Your Railway Domain
1. Go to **"Deployments"** tab
2. Copy the public URL (e.g., `https://vame-hubspot-app.railway.app`)
3. Save this URL - you'll need it for Zapier configuration

### Step 5: Update HubSpot OAuth Settings
1. Go to [HubSpot Developer Portal](https://developer.hubspot.com)
2. Update your app's **Redirect URIs** to include:
   - `https://YOUR_RAILWAY_DOMAIN/auth/hubspot/callback`

### Step 6: Configure Zapier Webhook
1. In Zapier, set the webhook URL to:
   ```
   https://YOUR_RAILWAY_DOMAIN/webhook/form-submission
   ```
2. This will forward Wix form submissions to your HubSpot CRM

### Monitoring & Logs
- View deployment logs in Railway dashboard under **"Deployments"**
- Check the **"Logs"** tab to debug issues

