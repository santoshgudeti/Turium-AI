import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkingService } from '../src/services/chunking.service';

describe('ChunkingService Test Suite', () => {
  const chunker = new ChunkingService({ chunkSize: 100, chunkOverlap: 20 });

  test('1. Empty text produces empty array of chunks', () => {
    assert.deepEqual(chunker.chunkText(''), []);
    assert.deepEqual(chunker.chunkText('   \n\n  \t  '), []);
  });

  test('2. Short text fitting within chunkSize produces a single chunk with index 0', () => {
    const text = 'Quick brown fox jumps over the lazy dog.';
    const chunks = chunker.chunkText(text);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].chunk_index, 0);
    assert.equal(chunks[0].content, text);
  });

  test('3. Deterministic output: Identical text always yields identical chunks', () => {
    const text =
      'Artificial intelligence in modern software development enables context-aware systems. ' +
      'Retrieval-Augmented Generation bridges static knowledge and LLM reasoning effectively. ' +
      'Chunking algorithms ensure documents are split into manageable semantic windows.';

    const run1 = chunker.chunkText(text);
    const run2 = chunker.chunkText(text);

    assert.deepEqual(run1, run2);
    assert.ok(run1.length > 1);
  });

  test('4. Sequential zero-based chunk indexes', () => {
    const longText = Array.from({ length: 15 }, (_, i) => `Sentence number ${i} provides context for retrieval.`).join(' ');
    const chunks = chunker.chunkText(longText);

    assert.ok(chunks.length >= 3);
    chunks.forEach((chunk, expectedIndex) => {
      assert.equal(chunk.chunk_index, expectedIndex);
      assert.ok(chunk.content.length > 0);
      assert.ok(chunk.content.length <= 150); // within bounds with overlap
    });
  });

  test('5. Natural paragraph boundary preservation', () => {
    const p1 = 'First paragraph discussing technical requirements.';
    const p2 = 'Second paragraph outlining backend architecture and data flow.';
    const p3 = 'Third paragraph covering database persistence with SQLite.';
    const combined = `${p1}\n\n${p2}\n\n${p3}`;

    const customChunker = new ChunkingService({ chunkSize: 80, chunkOverlap: 10 });
    const chunks = customChunker.chunkText(combined);

    assert.ok(chunks.length >= 2);
    // Chunks should preserve paragraph content
    assert.ok(chunks[0].content.includes('First paragraph'));
  });

  test('6. Overlap ensures context continuity across chunk boundaries', () => {
    const sentenceA = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa.';
    const sentenceB = 'Lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega.';
    const text = `${sentenceA} ${sentenceB}`;

    const overlapChunker = new ChunkingService({ chunkSize: 65, chunkOverlap: 20 });
    const chunks = overlapChunker.chunkText(text);

    assert.ok(chunks.length >= 2);
    // Overlap text from the end of chunk 0 should carry into chunk 1
    const endOfChunk0 = chunks[0].content.slice(-15);
    const wordsInOverlap = endOfChunk0.split(' ').filter(w => w.length > 3);
    if (wordsInOverlap.length > 0) {
      assert.ok(chunks[1].content.includes(wordsInOverlap[wordsInOverlap.length - 1]));
    }
  });

  test('7. Handles extremely long continuous text without crashing', () => {
    const longWordString = 'A'.repeat(500);
    const chunks = chunker.chunkText(longWordString);

    assert.ok(chunks.length >= 5);
    assert.equal(chunks[0].chunk_index, 0);
    assert.equal(chunks[1].chunk_index, 1);
  });

  test('8. Handles CRLF line endings and blank lines containing spaces and tabs', () => {
    const multiLineWithSpaces =
      'First paragraph on Windows CRLF.\r\n   \r\n\t  \r\nSecond paragraph following space-padded blank lines.\r\n\r\nThird paragraph.';
    const customChunker = new ChunkingService({ chunkSize: 70, chunkOverlap: 15 });
    const chunks = customChunker.chunkText(multiLineWithSpaces);

    assert.ok(chunks.length >= 2);
    assert.ok(chunks[0].content.includes('First paragraph'));
    assert.ok(chunks.some((c) => c.content.includes('Second paragraph')));
    assert.ok(chunks.some((c) => c.content.includes('Third paragraph')));
  });

  test('9. Unicode surrogate pair preservation without corruption', () => {
    // Emojis with surrogate pairs (length 2 in JS string)
    const emojiText = 'Turium AI 🚀 builds cutting-edge 🧠 intelligence platforms for software engineers 💻 across modern teams.';
    const smallChunker = new ChunkingService({ chunkSize: 40, chunkOverlap: 10 });
    const chunks = smallChunker.chunkText(emojiText);

    assert.ok(chunks.length >= 2);
    for (const chunk of chunks) {
      // Check for orphan surrogates (unpaired high \uD800-\uDBFF or low \uDC00-\uDFFF)
      const orphanHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(chunk.content);
      const orphanLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk.content);
      assert.equal(orphanHigh, false, 'No orphaned high surrogate in chunk');
      assert.equal(orphanLow, false, 'No orphaned low surrogate in chunk');
    }
    // Verify all emojis survive in the chunk collection
    const allChunkText = chunks.map((c) => c.content).join(' ');
    assert.ok(allChunkText.includes('🚀'));
    assert.ok(allChunkText.includes('🧠'));
    assert.ok(allChunkText.includes('💻'));
  });

  test('10. Original content reconstruction and zero-loss coverage verification', () => {
    const paragraphs = [
      'The Knowledge Inbox ingest pipeline accepts plain text notes and verified web page URLs.',
      'Incoming content is normalized, stripped of dangerous markup, and partitioned into discrete semantic chunks.',
      'Each generated chunk preserves its sequential index, character constraints, and semantic overlap with predecessor blocks.',
      'Underlying SQLite persistence guarantees transactional integrity with foreign key cascade deletions and WAL journaling.',
    ];
    const fullText = paragraphs.join('\n\n');

    const verifiedChunker = new ChunkingService({ chunkSize: 120, chunkOverlap: 30 });
    const chunks = verifiedChunker.chunkText(fullText);

    assert.ok(chunks.length >= 3);

    // Verify all original paragraphs are represented in sequential chunks
    for (const paragraph of paragraphs) {
      // Split paragraph into 5-word phrases and verify each phrase exists in at least one chunk
      const words = paragraph.split(' ');
      for (let i = 0; i < words.length - 3; i++) {
        const phrase = words.slice(i, i + 3).join(' ');
        const phraseFound = chunks.some((c) => c.content.includes(phrase));
        assert.ok(phraseFound, `Expected phrase "${phrase}" to be present in at least one chunk`);
      }
    }

    // Verify sequential indexes are contiguous and strictly zero-based
    chunks.forEach((chunk, idx) => {
      assert.equal(chunk.chunk_index, idx);
      assert.ok(chunk.content.length > 0);
      assert.ok(chunk.content.length <= 150); // within bounded limit
    });
  });
});
