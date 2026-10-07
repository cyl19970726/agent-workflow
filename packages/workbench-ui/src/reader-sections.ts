export type ReaderView = 'body' | 'visual' | 'evidence';
export interface ReaderSection {
  title: string;
  text: string;
  view?: ReaderView;
  pointer?: string;
  sourceRefs?: string[];
}

/** Older saved readers have no view. Their sections remain in the body. */
export function sectionsForView<T extends ReaderSection>(sections: readonly T[], view: ReaderView): T[] {
  return sections.filter(section => (section.view || 'body') === view);
}
