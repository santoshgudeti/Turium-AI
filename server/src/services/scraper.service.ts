import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import ipaddr from 'ipaddr.js';
import { AppError } from '../middleware/error-handler.middleware';
import { logger } from '../utils/logger';

export interface ExtractedPage {
  url: string;
  title: string;
  content: string;
  contentType: string;
}

/**
 * Pre-compiled Special-Purpose and Reserved Subnets for SSRF Prevention
 * Matches RFC specifications across IPv4 and IPv6:
 * IPv4:
 *  - 0.0.0.0/8 (RFC 1122 - "This network")
 *  - 10.0.0.0/8 (RFC 1918 - Private-use)
 *  - 100.64.0.0/10 (RFC 6598 - Shared Address Space / Carrier-grade NAT)
 *  - 127.0.0.0/8 (RFC 1122 - Loopback)
 *  - 169.254.0.0/16 (RFC 3927 - Link-local)
 *  - 172.16.0.0/12 (RFC 1918 - Private-use)
 *  - 192.0.0.0/24 (RFC 6890 - IETF Protocol Assignments)
 *  - 192.0.2.0/24 (RFC 5737 - TEST-NET-1 documentation)
 *  - 192.88.99.0/24 (RFC 7526 - 6to4 relay anycast, deprecated)
 *  - 192.168.0.0/16 (RFC 1918 - Private-use)
 *  - 198.18.0.0/15 (RFC 2544 - Network benchmark tests)
 *  - 198.51.100.0/24 (RFC 5737 - TEST-NET-2 documentation)
 *  - 203.0.113.0/24 (RFC 5737 - TEST-NET-3 documentation)
 *  - 224.0.0.0/4 (RFC 5771 - Multicast)
 *  - 240.0.0.0/4 (RFC 1112 - Reserved for future use)
 *  - 255.255.255.255/32 (RFC 919 - Limited broadcast)
 *
 * IPv6:
 *  - ::/128 (RFC 4291 - Unspecified)
 *  - ::1/128 (RFC 4291 - Loopback)
 *  - 100::/64 (RFC 6666 - Discard prefix)
 *  - 2001:20::/28 (RFC 7343 - ORCHIDv2)
 *  - 2001:db8::/32 (RFC 3849 - Documentation)
 *  - 2002::/16 (RFC 7526 - 6to4 relay anycast)
 *  - fc00::/7 (RFC 4193 - Unique Local Address / ULA)
 *  - fe80::/10 (RFC 4291 - Link-local unicast)
 *  - ff00::/8 (RFC 4291 - Multicast)
 */
const BLOCKED_IPV4_CIDRS: [ipaddr.IPv4, number][] = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
].map((cidr) => ipaddr.parseCIDR(cidr) as [ipaddr.IPv4, number]);

const BLOCKED_IPV6_CIDRS: [ipaddr.IPv6, number][] = [
  '::/128',
  '::1/128',
  '100::/64',
  '2001:20::/28',
  '2001:db8::/32',
  '2002::/16',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
].map((cidr) => ipaddr.parseCIDR(cidr) as [ipaddr.IPv6, number]);

export class ScraperService {
  private maxRedirects = 5;
  private timeoutMs = 8000;
  private maxSizeBytes = 2 * 1024 * 1024; // 2 MB limit

  /**
   * Determine if an IP address is private, loopback, link-local, or reserved (SSRF protection)
   * Evaluates canonical IPv4, IPv6, IPv4-mapped IPv6, and IPv4-compatible IPv6 addresses.
   */
  static isPrivateOrBlockedIP(ip: string): boolean {
    try {
      const targetIp = ip.trim();

      // Check for IPv4-compatible IPv6 addresses (e.g., ::192.168.1.1)
      if (targetIp.startsWith('::') && !targetIp.startsWith('::ffff:')) {
        const candidateV4 = targetIp.slice(2);
        if (net.isIPv4(candidateV4)) {
          return ScraperService.isPrivateOrBlockedIP(candidateV4);
        }
      }

      if (!ipaddr.isValid(targetIp)) {
        // Any malformed or non-standard IP format is blocked by default
        return true;
      }

      const parsed = ipaddr.parse(targetIp);

      if (parsed.kind() === 'ipv6') {
        const v6 = parsed as ipaddr.IPv6;
        // IPv4-mapped IPv6 addresses (e.g. ::ffff:192.168.1.1)
        if (v6.isIPv4MappedAddress()) {
          const v4 = v6.toIPv4Address();
          return BLOCKED_IPV4_CIDRS.some((range) => v4.match(range));
        }
        return BLOCKED_IPV6_CIDRS.some((range) => v6.match(range));
      }

      if (parsed.kind() === 'ipv4') {
        const v4 = parsed as ipaddr.IPv4;
        return BLOCKED_IPV4_CIDRS.some((range) => v4.match(range));
      }

      return true;
    } catch {
      // Fail closed on any parsing exception
      return true;
    }
  }

  /**
   * Validate destination URL syntax and verify DNS resolution against SSRF boundaries
   */
  async validateTargetUrl(rawUrl: string): Promise<URL> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new AppError(400, 'Invalid URL format provided');
    }

    // 1. Enforce HTTP / HTTPS protocol
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new AppError(400, 'Only HTTP and HTTPS URLs are supported');
    }

    // 2. Reject credentials embedded in URL
    if (parsedUrl.username || parsedUrl.password) {
      throw new AppError(400, 'Embedded credentials in URLs are not permitted');
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    // 3. Reject local hostnames
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan')
    ) {
      throw new AppError(400, 'Access to local or private network domains is blocked');
    }

    // 4. Resolve hostname and inspect all associated IP addresses
    if (net.isIP(hostname)) {
      if (ScraperService.isPrivateOrBlockedIP(hostname)) {
        throw new AppError(400, 'Access to private or restricted IP addresses is blocked');
      }
    } else {
      try {
        const records = await dns.lookup(hostname, { all: true });
        if (!records || records.length === 0) {
          throw new AppError(502, 'Could not resolve domain name');
        }

        for (const record of records) {
          if (ScraperService.isPrivateOrBlockedIP(record.address)) {
            logger.warn(
              { hostname, address: record.address },
              'SSRF Attempt Blocked: Hostname resolved to private address'
            );
            throw new AppError(400, 'Domain resolves to a prohibited private network address');
          }
        }
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        logger.warn({ hostname, err }, 'DNS lookup failed for URL');
        throw new AppError(502, 'Failed to resolve destination hostname');
      }
    }

    return parsedUrl;
  }

  /**
   * Fetch URL with manual redirect inspection, size limits, and timeouts
   */
  async fetchUrl(rawUrl: string): Promise<{ body: string; finalUrl: string; contentType: string }> {
    let currentUrl = rawUrl;
    let redirectCount = 0;

    while (redirectCount <= this.maxRedirects) {
      const validatedUrl = await this.validateTargetUrl(currentUrl);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await fetch(validatedUrl.toString(), {
          method: 'GET',
          redirect: 'manual', // Enforce manual redirect handling to re-validate SSRF on each hop
          headers: {
            'User-Agent': 'TuriumAI-KnowledgeInbox/1.0 (+https://turium.ai)',
            Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
          },
          signal: controller.signal,
        });
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        if (err instanceof Error && err.name === 'AbortError') {
          throw new AppError(504, 'Upstream request timed out while fetching URL');
        }
        logger.warn({ url: currentUrl, err }, 'Network error while fetching URL');
        throw new AppError(502, 'Failed to connect to the target URL');
      } finally {
        clearTimeout(timeoutId);
      }

      // Handle Redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) {
          throw new AppError(502, 'Redirect response missing Location header');
        }

        redirectCount++;
        if (redirectCount > this.maxRedirects) {
          throw new AppError(502, 'Too many redirects encountered while fetching URL');
        }

        // Resolve relative redirects against current URL
        try {
          currentUrl = new URL(location, validatedUrl).toString();
        } catch {
          throw new AppError(502, 'Redirect response contained an invalid Location header');
        }
        logger.info({ redirectCount, nextUrl: currentUrl }, 'Following safe validated redirect');
        continue;
      }

      // Validate HTTP Status
      if (!response.ok) {
        throw new AppError(502, `Upstream server returned HTTP status ${response.status}`);
      }

      // Validate Content-Type
      const rawContentType = response.headers.get('content-type') || 'text/html';
      const contentType = rawContentType.split(';')[0].trim().toLowerCase();

      const allowedTypes = ['text/html', 'application/xhtml+xml', 'text/plain'];
      if (!allowedTypes.includes(contentType)) {
        throw new AppError(
          415,
          `Unsupported content type: ${contentType}. Only web pages and plain text are supported.`
        );
      }

      // Validate Content-Length if present
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader && parseInt(contentLengthHeader, 10) > this.maxSizeBytes) {
        throw new AppError(413, 'Remote page content exceeds maximum allowed size (2MB)');
      }

      // Read Body with Streaming Size Guard to avoid buffering unbounded payload
      let bodyText = '';
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            totalBytes += value.length;
            if (totalBytes > this.maxSizeBytes) {
              await reader.cancel('Response body size exceeded 2MB limit');
              throw new AppError(413, 'Remote page content exceeds maximum allowed size (2MB)');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        bodyText = Buffer.concat(chunks).toString('utf-8');
      } else {
        bodyText = await response.text();
        if (bodyText.length > this.maxSizeBytes) {
          throw new AppError(413, 'Remote page content exceeds maximum allowed size (2MB)');
        }
      }

      return {
        body: bodyText,
        finalUrl: validatedUrl.toString(),
        contentType,
      };
    }

    throw new AppError(502, 'Exceeded maximum redirect limit');
  }

  /**
   * Extract title and readable body content from HTML
   */
  extractReadableContent(html: string, fallbackUrl: string): ExtractedPage {
    const $ = cheerio.load(html);

    // 1. Extract Page Title
    let title = $('title').text().trim();
    if (!title) {
      title = $('meta[property="og:title"]').attr('content')?.trim() || '';
    }
    if (!title) {
      title = $('meta[name="twitter:title"]').attr('content')?.trim() || '';
    }
    if (!title) {
      title = $('h1').first().text().trim();
    }
    if (!title) {
      try {
        const u = new URL(fallbackUrl);
        title = `Page from ${u.hostname}`;
      } catch {
        title = 'Untitled Web Page';
      }
    }

    // Clean up excessive whitespace in title
    title = title.replace(/\s+/g, ' ').slice(0, 200);

    // 2. Strip non-content and clutter elements
    $(
      'script, style, noscript, nav, footer, header, aside, form, svg, iframe, object, embed, [aria-hidden="true"], link, meta'
    ).remove();

    // 3. Locate primary content container (prefer <article> or <main>)
    let contentSelector = 'article';
    let text = $(contentSelector).text().trim();

    if (!text || text.length < 150) {
      contentSelector = 'main, [role="main"]';
      text = $(contentSelector).text().trim();
    }

    if (!text || text.length < 150) {
      contentSelector = 'body';
      text = $(contentSelector).text().trim();
    }

    // 4. Normalize Whitespace and Line Breaks
    const cleanContent = text
      .split('\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').trim())
      .filter((line) => line.length > 0)
      .join('\n\n');

    if (cleanContent.length < 10) {
      throw new AppError(422, 'Could not extract meaningful readable text from the provided URL');
    }

    return {
      url: fallbackUrl,
      title,
      content: cleanContent,
      contentType: 'text/html',
    };
  }

  /**
   * Full pipeline: validate, fetch, and extract readable content
   */
  async scrape(rawUrl: string): Promise<ExtractedPage> {
    const { body, finalUrl, contentType } = await this.fetchUrl(rawUrl);

    if (contentType === 'text/plain') {
      const u = new URL(finalUrl);
      const title = `Text file from ${u.hostname}${u.pathname}`;
      return {
        url: finalUrl,
        title: title.slice(0, 200),
        content: body.trim(),
        contentType,
      };
    }

    return this.extractReadableContent(body, finalUrl);
  }
}
