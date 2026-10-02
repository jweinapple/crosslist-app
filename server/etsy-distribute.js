/**
 * server/etsy-distribute.js — Etsy distribution via the Crosslist Connector
 * Chrome extension (extension-only distribution; no store API posting).
 *
 * Uniform distributor contract:
 *   distribute({ identity, price, photoPaths, photoUrls }, ctx)
 *     -> Promise<{ ok, marketplace: 'etsy', status: 'pending' | 'failed',
 *                  jobId?, extensionTask?, error? }>
 *
 * The returned extensionTask is relayed to the extension by the browser page
 * with the CREATE_MARKETPLACE_LISTINGS command; the page reports the real
 * outcome back through recordExtensionResults().
 */
import { createExtensionDistributor } from './extension-distribute.js';

const { marketplace, label, distribute } = createExtensionDistributor('etsy');

export { marketplace, label, distribute };
