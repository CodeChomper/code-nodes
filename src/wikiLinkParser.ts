export interface WikiLink {
  target: string;
  raw: string;
  index: number;
}

const WIKI_LINK_PATTERN = /\[\[([^\[\]\n]+)\]\]/g;

export function extractWikiLinks(content: string): WikiLink[] {
  // Construct a fresh RegExp each call — reusing a /g regex mutates lastIndex
  const re = new RegExp(WIKI_LINK_PATTERN.source, 'g');
  const links: WikiLink[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    links.push({
      target: match[1].trim(),
      raw: match[0],
      index: match.index,
    });
  }
  return links;
}

export function normalizeNoteName(name: string): string {
  return name.replace(/\.md$/i, '').toLowerCase().trim();
}
