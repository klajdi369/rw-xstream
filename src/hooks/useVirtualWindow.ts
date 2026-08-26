import React from 'react';

type Options = {
  itemCount: number;
  selectedIndex: number;
  itemHeight: number;
  overscan: number;
  active?: boolean;
  initialHeight?: number;
};

/**
 * Keep only the rows intersecting a scroll viewport mounted while preserving
 * the full list's scroll geometry. Selection scrolling is arithmetic, avoiding
 * scrollIntoView's full-tree layout pass on low-powered TV browsers.
 */
export function useVirtualWindow({
  itemCount,
  selectedIndex,
  itemHeight,
  overscan,
  active = true,
  initialHeight = 500,
}: Options) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [height, setHeight] = React.useState(initialHeight);

  React.useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const syncHeight = () => setHeight(element.clientHeight);
    syncHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncHeight);
      return () => window.removeEventListener('resize', syncHeight);
    }

    const observer = new ResizeObserver(syncHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  React.useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || itemCount === 0 || !active) return;

    const index = Math.max(0, Math.min(selectedIndex, itemCount - 1));
    const itemTop = index * itemHeight;
    const itemBottom = itemTop + itemHeight;
    const viewportTop = element.scrollTop;
    const viewportBottom = viewportTop + element.clientHeight;

    if (itemTop < viewportTop) {
      element.scrollTop = itemTop;
      setScrollTop(itemTop);
    } else if (itemBottom > viewportBottom) {
      const nextTop = itemBottom - element.clientHeight;
      element.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
  }, [active, itemCount, itemHeight, selectedIndex]);

  const maxScroll = Math.max(0, itemCount * itemHeight - height);
  const clampedScrollTop = Math.min(scrollTop, maxScroll);

  React.useEffect(() => {
    if (scrollTop > maxScroll) setScrollTop(maxScroll);
  }, [maxScroll, scrollTop]);

  const firstIndex = Math.max(0, Math.floor(clampedScrollTop / itemHeight) - overscan);
  const lastIndex = Math.min(
    itemCount - 1,
    Math.ceil((clampedScrollTop + height) / itemHeight) + overscan,
  );
  const onScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
  }, []);

  return {
    containerRef,
    firstIndex,
    lastIndex,
    beforeHeight: firstIndex * itemHeight,
    afterHeight: Math.max(0, itemCount - lastIndex - 1) * itemHeight,
    totalHeight: itemCount * itemHeight,
    onScroll,
  };
}
