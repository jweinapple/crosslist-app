const SECRET_KEYS = /password|secret|token|authorization|cookie|refresh/i;
const TRACE_LIMIT = 12;

function stripQuery(value) {
  const text = String(value || '');
  try {
    const parsed = new URL(text);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return text.split('?')[0];
  }
}

function compactValue(key, value, depth = 0) {
  if (value == null) return value;
  if (SECRET_KEYS.test(String(key || ''))) return '[redacted]';
  if (typeof value === 'string') {
    const text = /url|href/i.test(String(key)) || /^https?:\/\//i.test(value) ? stripQuery(value) : value;
    return text.length > 180 ? `${text.slice(0, 177)}…` : text;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth > 2) return `[${value.length} items]`;
    return value.slice(0, 8).map((item, index) => compactValue(index, item, depth + 1));
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    const out = {};
    for (const [nextKey, nextValue] of Object.entries(value).slice(0, 12)) {
      out[nextKey] = compactValue(nextKey, nextValue, depth + 1);
    }
    return out;
  }
  return undefined;
}

function compactStep(step) {
  const row = {
    at: step?.at || null,
    message: String(step?.message || '').slice(0, 300),
  };
  if (step?.extra && typeof step.extra === 'object') {
    const extra = compactValue('extra', step.extra);
    if (extra && typeof extra === 'object' && Object.keys(extra).length) row.extra = extra;
  }
  return row;
}

function httpStatus(detail) {
  if (Number.isFinite(Number(detail?.status))) return Number(detail.status);
  const attempts = Array.isArray(detail?.attempts) ? detail.attempts : [];
  const failed = attempts.find((attempt) => Number(attempt?.status) === 0) || attempts.at(-1);
  return Number.isFinite(Number(failed?.status)) ? Number(failed.status) : null;
}

export function compactListingFailure(listing, platform, response, steps) {
  const detail = response?.detail && typeof response.detail === 'object' ? response.detail : {};
  const marketplaceCode = detail.code || detail.errorCode || detail.errorId || null;
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    listingId: listing?.id ? String(listing.id).slice(0, 80) : null,
    title: listing?.title ? String(listing.title).slice(0, 120) : null,
    platform: String(platform || '').toLowerCase(),
    outcome: 'error',
    error: String(response?.error || `Could not list on ${platform}`).slice(0, 500),
    step: detail.step || null,
    status: httpStatus(detail),
    source: detail.source || 'extension',
    marketplaceCode: marketplaceCode ? String(marketplaceCode).slice(0, 80) : null,
    trace: (Array.isArray(steps) ? steps : []).slice(-TRACE_LIMIT).map(compactStep),
  };
}
