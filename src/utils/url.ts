const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'ref',
  'source',
  '_ga',
  'mc_cid',
  'mc_eid',
]);

/**
 * Normalizes an article or video URL by stripping tracking parameters,
 * hash fragments, and trailing slashes to guarantee consistent deduplication.
 */
export function normalizeArticleUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();

  try {
    const parsed = new URL(trimmed);

    // Remove tracking query parameters
    const keysToDelete: string[] = [];
    parsed.searchParams.forEach((_, key) => {
      if (TRACKING_PARAMS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        keysToDelete.push(key);
      }
    });
    for (const key of keysToDelete) {
      parsed.searchParams.delete(key);
    }

    // Remove hash/fragment
    parsed.hash = '';

    // Remove trailing slash if not root pathname
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return trimmed;
  }
}
