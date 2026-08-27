import { useState } from 'react';
import { Hand } from 'lucide-react';
import ThemeToggle from './ThemeToggle';

interface Props {
  title?: string;
  targetLang?: string;
  onEnter: (info: { name: string; company: string }) => void;
}

/**
 * Viewer onboarding shown before entering the room. Name/company are optional.
 * The result is persisted in localStorage (see viewerProfile) so returning
 * viewers skip this entirely.
 */
export default function Onboarding({ title, targetLang, onEnter }: Props) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onEnter({ name, company });
  };

  return (
    <div className="bg-aurora relative flex min-h-screen items-start justify-center px-6 pb-6 pt-20 sm:items-center sm:p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <form
        onSubmit={submit}
        className="glass-panel animate-fade-up w-full max-w-sm space-y-5 rounded-3xl p-8 shadow-2xl"
      >
        <div className="text-center">
          <div className="grad-fill mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl">
            <Hand size={24} strokeWidth={2} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">
            {title ? `Joining "${title}"` : 'Join the session'}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {targetLang ? `Live translation in ${targetLang}.` : 'Live translated presentation.'}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ada Lovelace"
              className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Company</label>
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="e.g. Analytical Engines Inc."
              className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
            />
          </div>
        </div>

        <p className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-3 py-2 text-xs leading-relaxed text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
          Optional — sharing your name just helps the host see who attended.
        </p>

        <button type="submit" className="btn-primary w-full rounded-[var(--r-md)] py-3 text-base">
          Enter the room
        </button>
        <button
          type="button"
          onClick={() => onEnter({ name: '', company: '' })}
          className="btn-ghost w-full rounded-[var(--r-md)] py-2.5 text-sm font-medium"
        >
          Enter without sharing
        </button>
      </form>
    </div>
  );
}
