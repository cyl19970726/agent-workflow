import type { ReactNode } from 'react';

// Reader prose is plain text. Recognize only simple explicit web links, leaving
// every other Markdown or HTML fragment to React's normal text escaping.
const WEB_LINK = /\[([^\]\r\n]+)\]\((https?:\/\/[^\s)\\\r\n]+)\)/gi;

export function safeInlineLinks(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let start = 0;
  for (const match of text.matchAll(WEB_LINK)) {
    const index = match.index;
    const [source, title, rawUrl] = match;
    if (index > start) parts.push(text.slice(start, index));
    let href: string | undefined;
    try {
      const url = new URL(rawUrl!);
      if (/^https?:\/\/[^/]/i.test(rawUrl!) && (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname) href = url.href;
    } catch { /* Invalid links remain literal text. */ }
    parts.push(href
      ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{title}</a>
      : source);
    start = index + source.length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}
