export function normalizeText(input: string): string {
  if (!input) {
    return "";
  }

  return input
    .replace(/\r/g, "")
    .replace(/\f/g, "\n")
    .replace(/-\n(?=\w)/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s*\d+\s*$/gm, "")
    .trim();
}

export interface ChunkOptions {
  minChars?: number;
  maxChars?: number;
}

export function splitIntoChunks(text: string, options: ChunkOptions = {}): string[] {
  const minChars = options.minChars ?? 800;
  const maxChars = options.maxChars ?? 2000;

  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/g);
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) {
      continue;
    }

    if (!current) {
      current = trimmed;
      continue;
    }

    if ((current.length + trimmed.length + 1) <= maxChars) {
      current = `${current} ${trimmed}`;
      continue;
    }

    if (current.length < minChars && trimmed.length < maxChars) {
      current = `${current} ${trimmed}`;
      continue;
    }

    chunks.push(current);
    current = trimmed;
  }

  if (current) {
    chunks.push(current);
  }

  if (chunks.length === 0) {
    return [normalized.slice(0, maxChars)];
  }

  return chunks;
}
