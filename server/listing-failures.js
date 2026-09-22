const SECRET_KEYS = /password|secret|token|authorization|cookie|refresh|code/i;
const SAFE_ID = /^[0-9a-zA-Z_-]{8,80}$/;
const TRACE_LIMIT = 12;

const PLATFORM_LABELS = {
  ebay: 'eBay',
  facebook: 'Facebook',
  depop: 'Depop',
  poshmark: 'Poshmark',
  etsy: 'Etsy',
  reverb: 'Reverb',
};

function stripQuery(value) {
  const text = String(value || '');
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text.split('?')[0];
  }
}

function scrubValue(key, value, depth = 0) {
  if (value == null) return value;
  if (SECRET_KEYS.test(String(key || '')) && key !== 'marketplaceCode') return '[redacted]';
  if (typeof value === 'string') {
    const text = /url|href/i.test(String(key)) || /^https?:\/\//i.test(value) ? stripQuery(value) : value;
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth > 2) return `[${value.length} items]`;
    return value.slice(0, 8).map((item, index) => scrubValue(index, item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    const out = {};
    for (const [nextKey, nextValue] of Object.entries(value).slice(0, 20)) {
      out[nextKey] = scrubValue(nextKey, nextValue, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function safeFailureId(value) {
  const id = String(value || '');
  return SAFE_ID.test(id) ? id : null;
}

export function platformFailureLabel(platform) {
  return PLATFORM_LABELS[platform] || platform || 'Store';
}

export function sanitizeListingFailure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const platform = String(raw.platform || '').toLowerCase().slice(0, 40);
  if (!platform) return null;
  const trace = Array.isArray(raw.trace) ? raw.trace.slice(-TRACE_LIMIT) : [];
  const status = Number(raw.status);
  return {
    id: safeFailureId(raw.id),
    at: raw.at ? String(raw.at).slice(0, 40) : null,
    listingId: raw.listingId ? String(raw.listingId).slice(0, 80) : null,
    title: raw.title ? String(raw.title).slice(0, 120) : null,
    platform,
    outcome: 'error',
    error: String(raw.error || 'Listing failed').slice(0, 500),
    step: raw.step ? String(raw.step).slice(0, 120) : null,
    status: Number.isFinite(status) ? status : null,
    source: String(raw.source || 'extension').slice(0, 40),
    marketplaceCode: raw.marketplaceCode ? String(raw.marketplaceCode).slice(0, 80) : null,
    trace: trace.map((step) => {
      const row = {
        at: step?.at ? String(step.at).slice(0, 40) : null,
        message: String(step?.message || '').slice(0, 300),
      };
      if (step?.extra && typeof step.extra === 'object') row.extra = scrubValue('extra', step.extra);
      return row;
    }),
  };
}

export function slimListingResult(result) {
  return {
    platform: result?.platform ? String(result.platform).slice(0, 40) : null,
    status: result?.status ? String(result.status).slice(0, 40) : null,
    listingId: result?.listingId ? String(result.listingId).slice(0, 80) : null,
    error: result?.error ? String(result.error).slice(0, 300) : null,
  };
}
