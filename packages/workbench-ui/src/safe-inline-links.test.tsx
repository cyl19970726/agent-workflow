import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { safeInlineLinks } from './safe-inline-links.js';

const render = (text: string) => renderToStaticMarkup(createElement('p', null, safeInlineLinks(text)));

describe('reader prose web links', () => {
  it('keeps the source title and surrounding prose while opening explicit web links safely', () => {
    expect(render('原帧：[打开准确原生报告与原帧](http://127.0.0.1:5177/report?run=1&view=frames) 后续'))
      .toBe('<p>原帧：<a href="http://127.0.0.1:5177/report?run=1&amp;view=frames" target="_blank" rel="noopener noreferrer">打开准确原生报告与原帧</a> 后续</p>');
    expect(render('[来源 A](https://example.org/a) 与 [来源 B](https://example.org/b)')).toContain('>来源 B</a>');
  });

  it('does not interpret HTML, non-web schemes, or malformed links', () => {
    const output = render('<script>alert(1)</script> [危险](javascript:alert(1)) [数据](data:text/html,x) [缺主机](https:///path)');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).toContain('[危险](javascript:alert(1))');
    expect(output).toContain('[数据](data:text/html,x)');
    expect(output).toContain('[缺主机](https:///path)');
    expect(output).not.toContain('<a ');
  });

  it('keeps link titles as escaped text', () => {
    expect(render('[<img src=x onerror=alert(1)>](https://example.org/)'))
      .toContain('&lt;img src=x onerror=alert(1)&gt;</a>');
  });
});
