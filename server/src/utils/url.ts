/**
 * Conservatively normalizes a web URL for duplicate identification:
 * - Trims whitespace
 * - Converts scheme and hostname to lowercase
 * - Strips client-side fragment identifiers (#hash)
 * - Removes root trailing slash only ('https://example.com/' -> 'https://example.com')
 *   while strictly preserving directory trailing slashes ('https://example.com/api/')
 * - Strictly preserves all query parameters and parameter order
 * - Strictly preserves character casing within paths and query strings
 */
export function normalizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return rawUrl;
  }
  const trimmed = rawUrl.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';

    // Strip trailing slash from pathname (e.g. '/article/' -> '/article')
    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    let result = parsed.toString();
    // Remove root trailing slash if no query parameters
    if (parsed.pathname === '/' && !parsed.search) {
      result = result.replace(/\/$/, '');
    }
    return result;
  } catch {
    return trimmed;
  }
}
