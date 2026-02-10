import { describe, expect, it } from 'vitest';
import { parseLimitedMarkdown } from './markdown';

describe('parseLimitedMarkdown', () => {
  it('escapes html tags', () => {
    const result = parseLimitedMarkdown('<script>alert(1)</script>');
    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('supports markdown links and raw urls', () => {
    const result = parseLimitedMarkdown('[video](https://youtu.be/demo)\nhttps://example.com');
    expect(result.html).toContain('href="https://youtu.be/demo"');
    expect(result.html).toContain('href="https://example.com"');
    expect(result.youtubeLinks).toContain('https://youtu.be/demo');
  });

  it('detects direct imgur images', () => {
    const result = parseLimitedMarkdown('https://i.imgur.com/demo.png');
    expect(result.imageLinks).toContain('https://i.imgur.com/demo.png');
  });
});
