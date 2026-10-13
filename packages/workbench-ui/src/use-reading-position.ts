import { useLayoutEffect, type RefObject } from 'react';
import { readReadingPosition, writeReadingPosition, type ReadingPosition } from './reading-position.js';

function detailId(element: HTMLDetailsElement, root: HTMLElement): string {
  if (element.id) return `id:${element.id}`;
  const parent = element.closest('[id]');
  const context = parent && root.contains(parent) ? parent.id : '';
  const summary = element.querySelector(':scope > summary')?.textContent?.trim() || '';
  const peers = Array.from(root.querySelectorAll('details')).filter(item => {
    const itemParent = item.closest('[id]');
    return (itemParent && root.contains(itemParent) ? itemParent.id : '') === context
      && (item.querySelector(':scope > summary')?.textContent?.trim() || '') === summary;
  });
  return `summary:${context}:${summary}:${peers.indexOf(element)}`;
}

/** Keep reading state with its exact document; asynchronous content may arrive after navigation. */
export function useReadingPosition(ref: RefObject<HTMLDivElement | null>, key: string | undefined): void {
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root || !key) return;
    const saved = readReadingPosition(sessionStorage, key);
    let state: ReadingPosition = saved || { top: 0, openDetails: [] };
    let userMoved = false;
    let applying = false;
    const applied = new WeakSet<HTMLDetailsElement>();
    const details = () => Array.from(root.querySelectorAll<HTMLDetailsElement>('details'));
    const persist = () => writeReadingPosition(sessionStorage, key, state);
    const restore = () => {
      if (userMoved || !saved) return;
      applying = true;
      for (const detail of details()) {
        if (applied.has(detail)) continue;
        detail.open = state.openDetails.includes(detailId(detail, root));
        applied.add(detail);
      }
      root.scrollTop = state.top;
      applying = false;
    };
    root.scrollTop = 0;
    restore();
    const onScroll = () => {
      if (applying || !userMoved) return;
      state = { ...state, top: root.scrollTop };
      persist();
    };
    const onToggle = (event: Event) => {
      if (applying || !userMoved || !(event.target instanceof HTMLDetailsElement)) return;
      state = { top: root.scrollTop, openDetails: details().filter(item => item.open).map(item => detailId(item, root)) };
      persist();
    };
    const observedChildren = new Set<Element>();
    const resizeObserver = saved ? new ResizeObserver(() => restore()) : undefined;
    const observeContent = () => {
      if (!resizeObserver) return;
      for (const child of root.children) {
        if (observedChildren.has(child)) continue;
        resizeObserver.observe(child);
        observedChildren.add(child);
      }
    };
    const observer = saved ? new MutationObserver(() => { observeContent(); restore(); }) : undefined;
    let frame = 0;
    const onImageLoad = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => restore());
    };
    const stopRestoring = () => {
      observer?.disconnect();
      resizeObserver?.disconnect();
      root.removeEventListener('load', onImageLoad, true);
      window.cancelAnimationFrame(frame);
    };
    const onUserMove = () => {
      if (!userMoved) {
        // Default-open sources also belong to the reading state, even when the first action is only a scroll.
        state = { top: root.scrollTop, openDetails: details().filter(item => item.open).map(item => detailId(item, root)) };
        persist();
      }
      userMoved = true;
      stopRestoring();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('toggle', onToggle, true);
    for (const kind of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) root.addEventListener(kind, onUserMove, { passive: true });
    if (saved) {
      root.addEventListener('load', onImageLoad, true);
      observer?.observe(root, { childList: true, subtree: true });
      observeContent();
    }
    return () => {
      stopRestoring();
      root.removeEventListener('scroll', onScroll);
      root.removeEventListener('toggle', onToggle, true);
      for (const kind of ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const) root.removeEventListener(kind, onUserMove);
    };
  }, [ref, key]);
}
