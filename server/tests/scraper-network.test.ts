import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ScraperService } from '../src/services/scraper.service';
import { AppError } from '../middleware/error-handler.middleware';

describe('Scraper Network Security & Edge Cases Test Suite', () => {
  // Use public IP address (e.g. 93.184.216.34) so tests run 100% offline without live DNS queries
  const publicBase = 'https://93.184.216.34';

  test('1. Redirect to a private IP is intercepted and blocked', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr.includes('redirect-to-aws')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        });
      }
      return originalFetch(input);
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/redirect-to-aws`),
        (err: AppError) => {
          return err.statusCode === 400 && err.message.includes('private or restricted IP');
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('2. Multiple safe redirects are followed to final destination', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (input: RequestInfo | URL) => {
      const urlStr = input.toString();
      if (urlStr === `${publicBase}/hop1`) {
        return new Response(null, { status: 301, headers: { location: '/hop2' } });
      }
      if (urlStr === `${publicBase}/hop2`) {
        return new Response(null, { status: 302, headers: { location: `${publicBase}/final` } });
      }
      if (urlStr === `${publicBase}/final`) {
        return new Response(
          '<html><head><title>Final Page</title></head><body><article>Extracted content from final hop.</article></body></html>',
          {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }
        );
      }
      return originalFetch(input);
    };

    try {
      const result = await testScraper.fetchUrl(`${publicBase}/hop1`);
      assert.equal(result.finalUrl, `${publicBase}/final`);
      assert.ok(result.body.includes('Extracted content from final hop'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('3. Redirect loop or exceeding maximum redirect limit throws HTTP 502', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    let count = 0;
    globalThis.fetch = async () => {
      count++;
      return new Response(null, {
        status: 302,
        headers: { location: `${publicBase}/hop-${count}` },
      });
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/loop`),
        (err: AppError) => err.statusCode === 502 && err.message.includes('Too many redirects')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('4. Redirect with missing or malformed Location header throws HTTP 502', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response(null, { status: 301 }); // missing location header
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/bad-redirect`),
        (err: AppError) => err.statusCode === 502 && err.message.includes('missing Location header')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('5. Unsupported MIME types (PDF, binaries, images) are rejected with HTTP 415', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response('%PDF-1.4 dummy binary content', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/manual.pdf`),
        (err: AppError) => err.statusCode === 415 && err.message.includes('Unsupported content type')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('6. Oversized streamed response exceeding 2MB is aborted with HTTP 413', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    // Stream chunks that exceed 2MB
    const largeChunk = new Uint8Array(1024 * 1024); // 1 MB
    largeChunk.fill(65); // 'A'

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.enqueue(largeChunk);
        controller.enqueue(largeChunk); // 3 MB total
        controller.close();
      },
    });

    globalThis.fetch = async () => {
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/oversized-page`),
        (err: AppError) => err.statusCode === 413 && err.message.includes('exceeds maximum allowed size')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('7. Content-Length header declaring oversized content is rejected immediately with HTTP 413', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response('small body', {
        status: 200,
        headers: {
          'content-type': 'text/html',
          'content-length': (10 * 1024 * 1024).toString(), // 10 MB declared
        },
      });
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/declared-large`),
        (err: AppError) => err.statusCode === 413 && err.message.includes('exceeds maximum allowed size')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('8. Upstream HTTP 404 or 500 error produces clean HTTP 502', async () => {
    const testScraper = new ScraperService();
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () => {
      return new Response('Not Found', { status: 404 });
    };

    try {
      await assert.rejects(
        () => testScraper.fetchUrl(`${publicBase}/non-existent`),
        (err: AppError) => err.statusCode === 502 && err.message.includes('HTTP status 404')
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
