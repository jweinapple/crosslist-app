# Crosslist

A seller dashboard for inventory, import, and listing across eBay, Facebook Marketplace, Depop, Poshmark, Etsy, and Reverb.

## What it does

- Connect your stores
- Import existing listings into one inventory
- Create and update items from the dashboard
- Push listings to the stores you choose

Facebook Marketplace has no public listing API, so that connection uses the **Crosslist Connector** Chrome extension and your existing browser login.

## Run locally

You need Node.js 24.

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Put your own marketplace and Google app credentials in `.env`. Leave unused values blank. Never commit `.env`.

## Chrome extension

1. Open Chrome → `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** and choose the `extension` folder
4. Keep the dashboard open and connect Facebook Marketplace from the Marketplaces page

Reload the extension after you pull updates.

## Deploy

This app can run on Vercel. After deploy, set `BASE_URL` to your public site URL, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and register that same origin plus `/api/auth/google/callback` in Google Cloud. Do not copy localhost redirect URIs into Vercel.

## Safety

Do not put real keys, tokens, passwords, or listing data in git. Local databases and `.env` are ignored.
