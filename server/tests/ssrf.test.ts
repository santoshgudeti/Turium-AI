import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScraperService } from '../src/services/scraper.service';
import { AppError } from '../middleware/error-handler.middleware';

describe('SSRF Protection & Content Extraction Test Suite', () => {
  const scraper = new ScraperService();

  test('1. Blocks loopback IPv4 addresses (127.0.0.1, 127.0.0.2)', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('127.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('127.255.255.254'), true);
  });

  test('2. Blocks private RFC 1918 IPv4 addresses (10.x, 172.16-31.x, 192.168.x)', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('10.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('10.255.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('172.16.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('172.31.255.255'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.168.1.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.168.0.254'), true);
  });

  test('3. Blocks cloud metadata & link-local addresses (169.254.169.254, 0.0.0.0)', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('169.254.169.254'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('0.0.0.0'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('255.255.255.255'), true);
  });

  test('4. Blocks carrier-grade NAT addresses (100.64.0.0/10)', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('100.64.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('100.100.50.1'), true);
  });

  test('5. Blocks IPv6 loopback, link-local, unique local, and IPv4-mapped addresses', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('fe80::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('fc00::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('fd12:3456:789a::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:127.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:192.168.1.1'), true);
  });

  test('6. Allows legitimate public IPv4 and IPv6 addresses', () => {
    assert.equal(ScraperService.isPrivateOrBlockedIP('8.8.8.8'), false);
    assert.equal(ScraperService.isPrivateOrBlockedIP('1.1.1.1'), false);
    assert.equal(ScraperService.isPrivateOrBlockedIP('93.184.216.34'), false);
    assert.equal(ScraperService.isPrivateOrBlockedIP('2606:4700:4700::1111'), false);
  });

  test('7. Target URL validation rejects non-HTTP/HTTPS protocols', async () => {
    await assert.rejects(
      () => scraper.validateTargetUrl('file:///etc/passwd'),
      (err: AppError) => err.statusCode === 400 && err.message.includes('Only HTTP and HTTPS')
    );

    await assert.rejects(
      () => scraper.validateTargetUrl('ftp://ftp.example.com/file.txt'),
      (err: AppError) => err.statusCode === 400
    );
  });

  test('8. Target URL validation rejects embedded user credentials', async () => {
    await assert.rejects(
      () => scraper.validateTargetUrl('https://admin:secret@example.com'),
      (err: AppError) => err.statusCode === 400 && err.message.includes('credentials')
    );
  });

  test('9. Target URL validation rejects localhost and local domain names', async () => {
    await assert.rejects(
      () => scraper.validateTargetUrl('http://localhost:8080/metrics'),
      (err: AppError) => err.statusCode === 400
    );

    await assert.rejects(
      () => scraper.validateTargetUrl('http://service.internal/admin'),
      (err: AppError) => err.statusCode === 400
    );

    await assert.rejects(
      () => scraper.validateTargetUrl('http://printer.local/status'),
      (err: AppError) => err.statusCode === 400
    );
  });

  test('10. Cheerio extracts clean title and readable body while stripping scripts and styles', () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Turium AI Architecture Guide</title>
          <style>.ad { display: none; }</style>
          <script>console.log('malicious code');</script>
        </head>
        <body>
          <nav><a href="/">Home</a><a href="/login">Login</a></nav>
          <header><h1>Header Navigation</h1></header>
          <article>
            <h1>Production RAG Systems</h1>
            <p>Building minimal, production-grade knowledge inboxes requires intentional chunking and vector retrieval.</p>
            <p>Reliable systems isolate components and validate boundaries systematically.</p>
          </article>
          <footer>Copyright 2026 Turium AI</footer>
        </body>
      </html>
    `;

    const extracted = scraper.extractReadableContent(html, 'https://turium.ai/guide');

    assert.equal(extracted.title, 'Turium AI Architecture Guide');
    assert.ok(extracted.content.includes('Production RAG Systems'));
    assert.ok(extracted.content.includes('intentional chunking'));
    // Stripped elements should not be in the output content
    assert.ok(!extracted.content.includes('malicious code'));
    assert.ok(!extracted.content.includes('Copyright 2026'));
    assert.ok(!extracted.content.includes('Header Navigation'));
  });

  test('11. Extraction throws 422 if page has empty or meaningless text', () => {
    const emptyHtml = `
      <html>
        <head><title>Empty</title></head>
        <body><script>alert(1);</script><div>  </div></body>
      </html>
    `;

    assert.throws(
      () => scraper.extractReadableContent(emptyHtml, 'https://example.com/empty'),
      (err: AppError) => err.statusCode === 422
    );
  });

  test('12. Blocks extended IPv4 special-purpose ranges (RFC 7526, 2544, 6890, 5737)', () => {
    // 192.88.99.0/24 (6to4 Relay Anycast)
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.88.99.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.88.99.254'), true);

    // 198.18.0.0/15 (Network Benchmark Tests)
    assert.equal(ScraperService.isPrivateOrBlockedIP('198.18.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('198.19.255.254'), true);

    // 192.0.0.0/24 (IETF Protocol Assignments) & 192.0.2.0/24 (TEST-NET-1)
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('192.0.2.1'), true);

    // 198.51.100.0/24 (TEST-NET-2) & 203.0.113.0/24 (TEST-NET-3)
    assert.equal(ScraperService.isPrivateOrBlockedIP('198.51.100.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('203.0.113.1'), true);

    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    assert.equal(ScraperService.isPrivateOrBlockedIP('224.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('239.255.255.255'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('240.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('250.1.2.3'), true);
  });

  test('13. Blocks extended IPv6 special-purpose ranges (100::/64, 2001:20::/28, 2002::/16, ff00::/8)', () => {
    // 100::/64 (Discard prefix RFC 6666)
    assert.equal(ScraperService.isPrivateOrBlockedIP('100::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('100::abcd'), true);

    // 2001:20::/28 (ORCHIDv2 RFC 7343)
    assert.equal(ScraperService.isPrivateOrBlockedIP('2001:20::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('2001:2f:ffff:ffff::1'), true);

    // 2001:db8::/32 (Documentation RFC 3849)
    assert.equal(ScraperService.isPrivateOrBlockedIP('2001:db8::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('2001:db8:ffff::1'), true);

    // 2002::/16 (6to4 Relay Anycast RFC 7526)
    assert.equal(ScraperService.isPrivateOrBlockedIP('2002::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('2002:c058:6301::'), true);

    // ff00::/8 (Multicast)
    assert.equal(ScraperService.isPrivateOrBlockedIP('ff02::1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('ff05::2'), true);
  });

  test('14. Correctly classifies IPv4-mapped and IPv4-compatible IPv6 addresses', () => {
    // IPv4-mapped private / blocked addresses
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:192.88.99.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:198.18.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:10.0.0.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:127.0.0.1'), true);

    // IPv4-mapped public addresses (allowed)
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:8.8.8.8'), false);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::ffff:93.184.216.34'), false);

    // IPv4-compatible private addresses
    assert.equal(ScraperService.isPrivateOrBlockedIP('::192.168.1.1'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('::10.0.0.1'), true);

    // IPv4-compatible public addresses (allowed)
    assert.equal(ScraperService.isPrivateOrBlockedIP('::8.8.8.8'), false);

    // Malformed addresses default to blocked
    assert.equal(ScraperService.isPrivateOrBlockedIP('invalid-ip-string'), true);
    assert.equal(ScraperService.isPrivateOrBlockedIP('300.300.300.300'), true);
  });
});
