import React from 'react';
import { useVirtualWindow } from '../hooks/useVirtualWindow';

type VirtualListProps<T> = {
  items: T[];
  selectedIndex: number;
  active?: boolean;
  itemHeight?: number;
  overscan?: number;
  onPick: (index: number) => void;
  render: (item: T, index: number, selected: boolean) => React.ReactNode;
  classForIndex?: (item: T, index: number) => string;
};

export function VirtualList<T>({
  items,
  selectedIndex,
  active = true,
  itemHeight = 76,
  overscan = 5,
  onPick,
  render,
  classForIndex,
}: VirtualListProps<T>) {
  const {
    containerRef,
    firstIndex,
    lastIndex,
    totalHeight,
    onScroll,
  } = useVirtualWindow({
    itemCount: items.length,
    selectedIndex,
    itemHeight,
    overscan,
    active,
  });

  return (
    <div className="vScroll" ref={containerRef} onScroll={onScroll}>
      <div className="vSpacer" style={{ height: `${totalHeight}px` }} />
      <div className="vWindow">
        {items.slice(firstIndex, lastIndex + 1).map((item, idx) => {
          const i = firstIndex + idx;
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
