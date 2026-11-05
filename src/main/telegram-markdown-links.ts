const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;

export function hasMarkdownLink(text: string): boolean {
  MARKDOWN_LINK.lastIndex = 0;
  return MARKDOWN_LINK.test(text);
}

export function plainTextFromMarkdownLinks(text: string): string {
  return text.replace(MARKDOWN_LINK, (_match, label: string, url: string) =>
    label === url ? url : `${label} (${url})`
  );
}
