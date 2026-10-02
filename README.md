# Crosslist

A seller dashboard for inventory, import, and listing across eBay, Facebook Marketplace, Depop, Poshmark, Etsy, and Reverb.

## What it does

- Connect your stores
- Import existing listings into one inventory
- Create and update items from the dashboard
- Push listings to the stores you choose

Facebook Marketplace has no public listing API, so that connection uses the **Crosslist Connector** Chrome extension and your existing browser login.

## Auto-list flow (photos → confirm → distributed)

1. Open the Sell page and upload **only photos** of the item — no descriptions or details to type.
2. The app identifies the exact product (brand, model, size, color, condition) and suggests a market price from eBay sold comps. Requires `VISION_API_KEY` (see `.env.example`).
3. One confirmation screen shows what was found — *"Is this [product] at $[price] what you intended to list?"* — confirm or correct the product and/or price. This is not per-marketplace configuration.
4. The listing is then distributed automatically **through the Crosslist Connector Chrome extension** — every store (eBay, Grailed, Depop, Poshmark, Etsy, Reverb) is posted from your logged-in browser session. No store API credentials are needed for posting.
   - The Sell page hands each queued listing to the extension, which fills (and where the store allows, publishes) the listing on each store's site. Some stores leave the pre-filled composer open for you to review and publish yourself — those show as "needs review".
   - At distribution time you need: the extension installed and enabled in Chrome, logged into each store in that Chrome profile, and the Sell page open (the extension fetches listing photos from the page's origin).

Facebook Marketplace is intentionally **not** posted by the app — post it through Muse chat instead.

Per-marketplace status (listed / queued / guided / needs review / failed) is shown live, and failures are logged for review.

## Store connections

- **Posting** (all stores): Chrome extension only — no API keys needed.
- **Import** (read-only): eBay and Etsy use OAuth (kept in `.env.example`), Reverb uses a personal access token pasted in the app's Marketplaces page. Depop, Poshmark, and Grailed import via the extension's scraping.
- **Pricing**: eBay sold comps via the eBay Buy Browse API (`EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET`).

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
