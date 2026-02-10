type ParsedDescription = {
  html: string;
  imageLinks: string[];
  youtubeLinks: string[];
};

const URL_REGEX = /(https?:\/\/[^\s<]+)/gi;
const MARKDOWN_LINK_REGEX = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi;

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isDirectImgurImage(url: string): boolean {
  return /^https?:\/\/i\.imgur\.com\/[A-Za-z0-9]+\.(jpg|jpeg|png|gif)$/i.test(url);
}

function isYoutubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)/i.test(url);
}

function linkifyEscapedText(escaped: string): string {
  return escaped.replace(URL_REGEX, (match) => {
    const href = escapeHtml(match);
    return `<a href="${href}" target="_blank" rel="noreferrer">${href}</a>`;
  });
}

export function parseLimitedMarkdown(input: string): ParsedDescription {
  const imageLinks = new Set<string>();
  const youtubeLinks = new Set<string>();
  const markdownTokens = new Map<string, string>();
  let tokenIndex = 0;

  const escaped = escapeHtml(input);

  const withMarkdownLinks = escaped.replace(MARKDOWN_LINK_REGEX, (_full, text, url) => {
    const href = escapeHtml(url);
    if (isDirectImgurImage(url)) imageLinks.add(url);
    if (isYoutubeUrl(url)) youtubeLinks.add(url);
    const token = `__LINK_TOKEN_${tokenIndex++}__`;
    markdownTokens.set(
      token,
      `<a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`,
    );
    return token;
  });

  const withRawUrls = linkifyEscapedText(withMarkdownLinks);
  const lines = withRawUrls.split(/\r?\n/).map((line) => {
    for (const [token, anchor] of markdownTokens.entries()) {
      line = line.replaceAll(token, anchor);
    }
    return line || '&nbsp;';
  });

  const html = lines.join('<br />');
  const rawUrlMatches = input.match(URL_REGEX) ?? [];
  for (const url of rawUrlMatches) {
    if (isDirectImgurImage(url)) imageLinks.add(url);
    if (isYoutubeUrl(url)) youtubeLinks.add(url);
  }

  return {
    html,
    imageLinks: Array.from(imageLinks),
    youtubeLinks: Array.from(youtubeLinks),
  };
}
