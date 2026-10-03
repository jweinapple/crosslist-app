/**
 * server/blob-store.js — Vercel Blob photo storage (Stream 2 of the $0
 * persistence migration).
 *
 * When BLOB_READ_WRITE_TOKEN is set (Vercel dashboard → Storage → create a
 * Blob store; the token is auto-injected as an env var), uploaded photos go
 * to Vercel Blob and the returned public https URL becomes the photo's URL.
 * When unset, callers keep the existing local-disk behavior — zero new
 * config for local dev.
 */

import { put } from '@vercel/blob';

export const BLOB_TOKEN_ENV = 'BLOB_READ_WRITE_TOKEN';

/** True when Vercel Blob photo storage is configured. Read live so tests can toggle it. */
export function blobEnabled() {
  return Boolean(process.env[BLOB_TOKEN_ENV]);
}

/** Filename leaf safe for a Blob pathname: no slashes, no traversal, bounded length. */
export function sanitizeBlobFilename(filename, fallbackExt = 'jpg') {
  const leaf = String(filename || '').split('/').pop().split('\\').pop().trim();
  const cleaned = leaf.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') return `photo.${fallbackExt}`;
  return cleaned;
}

/** Content type for a stored image extension (the exts toStoredImage can return). */
export function contentTypeForExt(ext) {
  const map = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[String(ext || '').toLowerCase()] || 'application/octet-stream';
}

/**
 * Store photo bytes in Vercel Blob under uploads/<owner>/<name> and return
 * the public URL. Throws when the token is missing or the upload fails —
 * callers surface that as an error, never silently fall back to ephemeral
 * local disk (that would lose the photo on Vercel).
 */
export async function putBlobPhoto({ owner, name, buffer, contentType }) {
  const token = process.env[BLOB_TOKEN_ENV];
  if (!token) throw new Error(`${BLOB_TOKEN_ENV} is not set`);
  const { url } = await put(`uploads/${owner}/${name}`, buffer, {
    access: 'public',
    token,
    contentType: contentType || 'application/octet-stream',
  });
  return url;
}
