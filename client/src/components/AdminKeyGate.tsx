import { useState, type ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getAdminKey, setAdminKey, verifyAdminKey } from '../lib/adminKey';

/**
 * One-field "enter admin key" prompt (spec §2). Key lives in sessionStorage;
 * children render only once the key has been verified against the server.
 */
export default function AdminKeyGate({ children }: { children: ReactNode }) {
  const [key, setKey] = useState(getAdminKey() ?? '');
  const [verified, setVerified] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Auto-verify a stored key once on mount.
  const [autoChecked, setAutoChecked] = useState(false);
  if (!autoChecked) {
    setAutoChecked(true);
    const stored = getAdminKey();
    if (stored) {
      void verifyAdminKey(stored).then((ok) => setVerified(ok));
    }
  }

  if (verified) return <>{children}</>;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError(null);
    const ok = await verifyAdminKey(key).catch(() => false);
    setChecking(false);
    if (ok) {
      setAdminKey(key);
      setVerified(true);
    } else {
      setError('Invalid key (or rate-limited — wait a minute and retry).');
    }
  };

  return (
    <div className="bg-aurora flex min-h-screen items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="glass-panel grad-border animate-fade-up w-full max-w-sm rounded-3xl p-8 shadow-2xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <div className="grad-fill flex h-10 w-10 items-center justify-center rounded-xl">
            <Lock size={21} />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[var(--fg)]">Presenter access</h1>
            <p className="text-xs text-[var(--faint)]">Enter your presenter key to continue</p>
          </div>
        </div>
        <input
          type="password"
          autoFocus
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Presenter key"
          className="input-field mb-3 w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
        />
        {error && <p className="mb-3 text-sm text-error">{error}</p>}
        <button
          type="submit"
          disabled={checking || key.length === 0}
          className="btn-primary w-full rounded-xl py-2.5"
        >
          {checking ? 'Checking…' : 'Continue'}
        </button>
        <Link
          to="/"
          className="mt-4 block text-center text-sm text-[var(--muted)] transition hover:text-[var(--fg)]"
        >
          Back to Fluent
        </Link>
      </form>
    </div>
  );
}
