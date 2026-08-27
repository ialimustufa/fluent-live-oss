import type { FloatingReaction } from '../lib/useReactions';

/** Overlay that floats reaction emojis upward (Google-Meet style). */
export default function ReactionLayer({ items }: { items: FloatingReaction[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      {items.map((r) => (
        <span
          key={r.id}
          className="animate-float-up absolute bottom-10 text-5xl drop-shadow-lg sm:text-6xl"
          style={{ left: `${r.left}%` }}
        >
          {r.emoji}
        </span>
      ))}
    </div>
  );
}
