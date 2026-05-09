export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

export interface TextChunk {
  chunkId: string;
  filePath: string;
  text: string;
  excerpt: string;
  startLine: number;
  endLine: number;
}

function excerptFromText(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  return compact.length > 280 ? `${compact.slice(0, 277)}...` : compact;
}

export function chunkDocument(filePath: string, source: string, options: ChunkOptions): TextChunk[] {
  const lines = source.split(/\r?\n/);
  const chunks: TextChunk[] = [];
  let index = 0;
  let chunkNumber = 0;

  while (index < lines.length) {
    let end = index;
    let size = 0;
    while (end < lines.length) {
      const nextSize = size + lines[end]!.length + 1;
      if (end > index && nextSize > options.chunkSize) {
        break;
      }
      size = nextSize;
      end += 1;
    }

    const slice = lines.slice(index, end);
    const text = slice.join('\n').trim();
    if (text.length > 0) {
      chunks.push({
        chunkId: `${filePath}#${chunkNumber}`,
        filePath,
        text,
        excerpt: excerptFromText(text),
        startLine: index + 1,
        endLine: end
      });
      chunkNumber += 1;
    }

    if (end >= lines.length) {
      break;
    }

    let overlapChars = 0;
    let nextIndex = end;
    while (nextIndex > index && overlapChars < options.chunkOverlap) {
      nextIndex -= 1;
      overlapChars += lines[nextIndex]!.length + 1;
    }
    index = Math.max(index + 1, nextIndex);
  }

  return chunks;
}
