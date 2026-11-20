export interface ChunkingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
}

export interface GeneratedChunk {
  chunk_index: number;
  content: string;
}

export class ChunkingService {
  private defaultChunkSize: number;
  private defaultOverlap: number;

  constructor(options?: ChunkingOptions) {
    this.defaultChunkSize = options?.chunkSize || 500;
    this.defaultOverlap = options?.chunkOverlap || 50;
  }

  /**
   * Split input text into deterministic chunks with natural boundary preservation and overlap
   */
  chunkText(text: string, options?: ChunkingOptions): GeneratedChunk[] {
    const rawText = text.trim();
    if (!rawText) {
      return [];
    }

    const chunkSize = options?.chunkSize ?? this.defaultChunkSize;
    const chunkOverlap = options?.chunkOverlap ?? this.defaultOverlap;

    if (chunkOverlap >= chunkSize) {
      throw new Error('chunkOverlap must be strictly smaller than chunkSize');
    }

    // If text fits entirely within a single chunk, return immediately
    if (rawText.length <= chunkSize) {
      return [{ chunk_index: 0, content: rawText }];
    }

    // Split raw text into natural semantic units: paragraphs first
    // Explicitly handles CRLF, LF, and lines containing whitespace or tabs
    const paragraphs = rawText
      .split(/(?:\r?\n[\t ]*){2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    // Further decompose paragraphs into sentences if any exceed chunkSize
    const units: string[] = [];
    for (const paragraph of paragraphs) {
      if (paragraph.length <= chunkSize) {
        units.push(paragraph);
      } else {
        // Split by sentence boundaries (. ? !) while retaining sentence meaning
        const sentences = paragraph
          .split(/(?<=[.?!])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const sentence of sentences) {
          if (sentence.length <= chunkSize) {
            units.push(sentence);
          } else {
            // Hard fallback: split long run-on sentences into words / slices
            const words = sentence.split(/\s+/);
            let currentWordSlice = '';
            for (const word of words) {
              if (word.length > chunkSize) {
                if (currentWordSlice) {
                  units.push(currentWordSlice);
                  currentWordSlice = '';
                }
                for (let i = 0; i < word.length; i += chunkSize) {
                  let slice = word.slice(i, i + chunkSize);
                  // Ensure we don't leave an orphaned high surrogate at the end
                  if (/[\uD800-\uDBFF]$/.test(slice) && i + chunkSize < word.length) {
                    slice += word[i + chunkSize];
                    i++;
                  }
                  units.push(slice);
                }
              } else if ((currentWordSlice + ' ' + word).trim().length <= chunkSize) {
                currentWordSlice = (currentWordSlice + ' ' + word).trim();
              } else {
                if (currentWordSlice) units.push(currentWordSlice);
                currentWordSlice = word;
              }
            }
            if (currentWordSlice) units.push(currentWordSlice);
          }
        }
      }
    }

    // Assemble units into bounded chunks with overlap
    const chunks: string[] = [];
    let currentChunk = '';

    for (const unit of units) {
      const candidate = currentChunk ? `${currentChunk}\n\n${unit}` : unit;

      if (candidate.length <= chunkSize) {
        currentChunk = candidate;
      } else {
        if (currentChunk.trim().length > 0) {
          chunks.push(currentChunk.trim());

          // Calculate overlap context from previous chunk
          if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
            let overlapText = currentChunk.slice(-chunkOverlap).trim();
            // Drop leading orphaned low surrogate if split occurred on a surrogate boundary
            if (/^[\uDC00-\uDFFF]/.test(overlapText)) {
              overlapText = overlapText.slice(1);
            }
            // Try to avoid cutting words in half in the overlap prefix
            const firstSpace = overlapText.indexOf(' ');
            const cleanOverlap = firstSpace !== -1 ? overlapText.substring(firstSpace + 1) : overlapText;
            currentChunk = cleanOverlap ? `${cleanOverlap}\n\n${unit}` : unit;
          } else {
            currentChunk = unit;
          }
        } else {
          // Single unit larger than chunkSize
          chunks.push(unit.slice(0, chunkSize).trim());
          currentChunk = unit.slice(chunkSize).trim();
        }
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    // Return deterministic sequential zero-indexed chunks
    return chunks.map((content, chunk_index) => ({
      chunk_index,
      content,
    }));
  }
}

export const defaultChunkingService = new ChunkingService();
