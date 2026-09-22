# Crosslist Connector (Chrome extension)

This mirrors how **Vendoo** connects marketplaces:

- **Facebook Marketplace** uses your existing Facebook login in Chrome (`extension: true` in Vendoo). There is no public Marketplace listing OAuth API.
- **eBay**, **Depop**, **Etsy**, and **Reverb** connect with OAuth when API credentials are in `.env`. This extension is an optional backup that reads your logged-in browser session.
- **Poshmark** signs in with email and password. The extension can use your browser session instead.

## Install (one time)

1. Run the dashboard: `npm start` from the project root.
2. Open Chrome → `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose this folder: `crosslist-app/extension`.
5. Open `http://localhost:3000/dashboard.html`. Use **Connect with Chrome extension** for Facebook Marketplace. Other stores use OAuth first.

## Connect flow

1. Extension checks Facebook/eBay/Depop cookies (`c_user`, eBay session cookies, Depop `access_token`).
2. If not logged in, it opens the marketplace login page — sign in, then click Connect again.
3. It imports live listings (Depop via API when possible, otherwise by scraping the shop page).
4. Listings are sent to the local dashboard API for bulk edit.

## Optional: eBay / Etsy / Depop / Reverb OAuth APIs

Add real credentials to `.env` so Connect uses official OAuth instead of browser scraping:

- eBay: `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` from [developer.ebay.com](https://developer.ebay.com/my/keys)
- Etsy: `ETSY_API_KEY` from [etsy.com/developers](https://www.etsy.com/developers/your-apps)
- Depop: partner `DEPOP_CLIENT_ID` / `DEPOP_CLIENT_SECRET` from [developers@depop.com](mailto:developers@depop.com)
- Reverb: `REVERB_CLIENT_ID` / `REVERB_CLIENT_SECRET` from [reverb.com/my/api_settings](https://reverb.com/my/api_settings)
