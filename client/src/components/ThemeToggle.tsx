import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../lib/useTheme';

/** Sun/moon toggle. Defaults to the OS preference until clicked, then sticks. */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const { effective, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      className={`btn-ghost flex h-9 w-9 items-center justify-center rounded-full text-[var(--muted)] ${className}`}
      title={effective === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle light/dark mode"
    >
      {effective === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
