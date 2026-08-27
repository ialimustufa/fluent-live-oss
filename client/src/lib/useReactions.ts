import { useCallback, useRef, useState } from 'react';

export interface FloatingReaction {
  id: number;
  emoji: string;
  left: number; // horizontal start position, 0..100 (%)
}

/**
 * Transient floating reactions (Google-Meet style). Each incoming reaction is
 * added with a unique id + random horizontal offset, then auto-pruned after the
 * float-up animation finishes.
 */
export function useReactions(lifeMs = 3200) {
  const [items, setItems] = useState<FloatingReaction[]>([]);
  const nextId = useRef(1);

  const push = useCallback(
    (emoji: string) => {
      const id = nextId.current++;
      const left = 10 + Math.random() * 80;
      setItems((cur) => [...cur, { id, emoji, left }]);
      setTimeout(() => setItems((cur) => cur.filter((r) => r.id !== id)), lifeMs);
    },
    [lifeMs]
  );

  return { items, push };
}
