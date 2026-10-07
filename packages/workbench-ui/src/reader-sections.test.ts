import { describe, expect, it } from 'vitest';
import { sectionsForView, type ReaderSection } from './reader-sections.js';

describe('saved reader sections', () => {
  it('groups custom sections without losing any section and keeps old fallback in body', () => {
    const sections: ReaderSection[] = [
      { title: 'Script', text: 'Saved body', view: 'body' },
      { title: 'Shot', text: 'Saved visual intent', view: 'visual' },
      { title: 'Source', text: 'Saved evidence', view: 'evidence' },
      { title: 'Older reader', text: 'Untyped saved section' },
    ];
    expect(sectionsForView(sections, 'body').map(value => value.title)).toEqual(['Script', 'Older reader']);
    expect(sectionsForView(sections, 'visual').map(value => value.title)).toEqual(['Shot']);
    expect(sectionsForView(sections, 'evidence').map(value => value.title)).toEqual(['Source']);
    expect(['body', 'visual', 'evidence'].flatMap(view => sectionsForView(sections, view as 'body' | 'visual' | 'evidence'))).toHaveLength(sections.length);
    expect(sectionsForView([{ title: 'JSON fallback', text: '{}' }], 'body')).toHaveLength(1);
  });
});
