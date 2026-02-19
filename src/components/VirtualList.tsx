import React from 'react';

type VirtualListProps<T> = {
  items: T[];
  selectedIndex: number;
  itemHeight?: number;
  overscan?: number;
  onPick: (index: number) => void;
  render: (item: T, index: number, selected: boolean) => React.ReactNode;
  classForIndex?: (item: T, index: number) => string;
};

export function VirtualList<T>({
  items,
  selectedIndex,
  itemHeight = 76,
  overscan = 5,
  onPick,
  render,
  classForIndex,
}: VirtualListProps<T>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [height, setHeight] = React.useState(500);

  React.useEffect(() => {
    if (ref.current) setHeight(ref.current.clientHeight);
  }, []);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || items.length === 0) return;

    const i = Math.max(0, Math.min(selectedIndex, items.length - 1));
    const top = i * itemHeight;
    const bottom = top + itemHeight;
    const st = el.scrollTop;
    const vh = el.clientHeight;

    if (top < st) {
      el.scrollTop = top;
      setScrollTop(top);
    } else if (bottom > st + vh) {
      const nextTop = bottom - vh;
      el.scrollTop = nextTop;
      setScrollTop(nextTop);
    }
  }, [itemHeight, items.length, selectedIndex]);

  const first = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
  const last = Math.min(items.length - 1, Math.ceil((scrollTop + height) / itemHeight) + overscan);

  return (
    <div className="vScroll" ref={ref} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
      <div className="vSpacer" style={{ height: `${items.length * itemHeight}px` }} />
      <div className="vWindow">
        {items.slice(first, last + 1).map((item, idx) => {
          const i = first + idx;
          const extra = classForIndex?.(item, i) ?? '';
          return (
            <div
              key={i}
              className={`item ${i === selectedIndex ? 'sel' : ''} ${extra}`.trim()}
              style={{ top: `${i * itemHeight + 3}px` }}
              onClick={() => onPick(i)}
            >
              {render(item, i, i === selectedIndex)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
