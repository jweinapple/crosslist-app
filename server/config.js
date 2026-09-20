import dotenv from 'dotenv';

dotenv.config();

const env = process.env;

export const config = {
  port: Number(env.PORT) || 3000,
  baseUrl: env.BASE_URL || `http://localhost:${Number(env.PORT) || 3000}`,

  ebay: {
    clientId: env.EBAY_CLIENT_ID || '',
    clientSecret: env.EBAY_CLIENT_SECRET || '',
    // Production by default so official app credentials can use Google SSO.
    // Set EBAY_USE_PRODUCTION=false for sandbox test users (no Google SSO).
    apiBase: env.EBAY_USE_PRODUCTION === 'false' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com',
    authBase: env.EBAY_USE_PRODUCTION === 'false' ? 'https://auth.sandbox.ebay.com' : 'https://auth.ebay.com',
    redirectUri: env.EBAY_REDIRECT_URI || '',
    scopes: [
      'https://api.ebay.com/oauth/api_scope',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ],
  },

  facebook: {
    // Marketplace listings use the Chrome extension, not Graph API OAuth.
    appId: env.FACEBOOK_APP_ID || '',
    appSecret: env.FACEBOOK_APP_SECRET || '',
    apiBase: 'https://graph.facebook.com/v19.0',
  },
};

// Live mode = real credentials configured. Otherwise demo mode.
export const modes = {
  ebay: config.ebay.clientId && config.ebay.clientSecret ? 'live' : 'demo',
  facebook: config.facebook.appId && config.facebook.appSecret ? 'live' : 'demo',
};
