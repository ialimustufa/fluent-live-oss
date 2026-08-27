import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Users } from 'lucide-react';
import {
  listSessions,
  updateSession,
  deleteSession,
  fetchLanguages,
  type SessionListItem,
  type Language,
} from '../lib/api';
import { getAdminKey } from '../lib/adminKey';
import AdminKeyGate from '../components/AdminKeyGate';
import ThemeToggle from '../components/ThemeToggle';

export default function AdminDashboard() {
  return (
    <AdminKeyGate>
      <Dashboard />
    </AdminKeyGate>
  );
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
  return new Date(s.replace(' ', 'T') + 'Z').toLocaleString();
}

const STATE_STYLE: Record<string, string> = {
  live: 'grad-border text-[var(--fg)] ring-transparent',
  reconnecting: 'bg-warning-soft text-warning ring-warning',
  paused: 'bg-warning-soft text-warning ring-warning',
  ended: 'bg-[var(--muted)]/15 text-[var(--muted)] ring-[var(--border)]',
  created: 'bg-[var(--surface-2)] text-[var(--muted)] ring-[var(--border)]',
};

function Dashboard() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ title: string; targetLang: string; echo: boolean }>({
    title: '',
    targetLang: 'es',
    echo: false,
  });
  const [busy, setBusy] = useState(false);

  const key = getAdminKey() ?? '';

  const refresh = () =>
    listSessions(key)
      .then(setSessions)
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    void refresh();
    void fetchLanguages().then(setLanguages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startEdit = (s: SessionListItem) => {
    setConfirmDelete(null);
    setEditing(s.slug);
    setDraft({ title: s.title, targetLang: s.targetLang, echo: s.echoTargetLanguage });
  };

  const saveEdit = async (slug: string) => {
    setBusy(true);
    try {
      await updateSession(key, slug, {
        title: draft.title,
        targetLang: draft.targetLang,
        echoTargetLanguage: draft.echo,
      });
      setEditing(null);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (slug: string) => {
    setBusy(true);
    try {
      await deleteSession(key, slug);
      setConfirmDelete(null);
      await refresh();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-aurora min-h-screen px-4 py-10">
      <div className="animate-fade-up mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[var(--fg)]">Your talks</h1>
            <p className="mt-1 text-sm text-[var(--faint)]">
              {sessions ? `${sessions.length} session${sessions.length === 1 ? '' : 's'}` : 'Loading...'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link to="/new" className="btn-primary flex items-center gap-1.5 rounded-xl px-4 py-2.5 text-sm">
              <Plus size={16} /> New presentation
            </Link>
          </div>
        </div>

        {error && (
          <p className="mb-4 rounded-[var(--r-md)] bg-error-soft px-3 py-2 text-sm text-error ring-1 ring-inset ring-error">
            {error}
          </p>
        )}

        {sessions && sessions.length === 0 && (
          <div className="glass-panel rounded-2xl px-6 py-12 text-center text-[var(--faint)]">
            No talks yet. Create your first presentation.
          </div>
        )}

        {sessions && (
          <div className="space-y-3">
            {sessions?.map((s) => (
              <div key={s.slug} className={`glass-panel rounded-2xl p-4 ${s.state === 'live' ? 'grad-border' : ''}`}>
                {editing === s.slug ? (
                  <div className="space-y-3">
                    <input
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      placeholder="Talk title"
                      className="input-field w-full px-3 py-2 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <select
                        value={draft.targetLang}
                        onChange={(e) => setDraft({ ...draft, targetLang: e.target.value })}
                        className="input-field px-3 py-2 text-sm text-[var(--fg)]"
                      >
                        {languages.map((l) => (
                          <option key={l.code} value={l.code} className="bg-[var(--surface)]">
                            {l.name} ({l.code})
                          </option>
                        ))}
                      </select>
                      <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                        <input
                          type="checkbox"
                          checked={draft.echo}
                          onChange={(e) => setDraft({ ...draft, echo: e.target.checked })}
                          className="accent-[var(--cyan)]"
                        />
                        Echo target language
                      </label>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => void saveEdit(s.slug)}
                        disabled={busy}
                        className="btn-primary rounded-lg px-4 py-1.5 text-sm"
                      >
                        Save
                      </button>
                      <button onClick={() => setEditing(null)} className="btn-ghost rounded-lg px-4 py-1.5 text-sm">
                        Cancel
                      </button>
                    </div>
                    {s.state === 'live' && (
                      <p className="text-[11px] text-warning">
                        Language changes take effect when the talk is next started.
                      </p>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate font-semibold text-[var(--fg)]">{s.title || 'Untitled talk'}</h2>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span
                            className={`rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ring-1 ring-inset ${
                              STATE_STYLE[s.state] ?? STATE_STYLE.created
                            }`}
                          >
                            {s.state === 'live' && <span className="live-dot mr-1.5" />}
                            {s.state}
                          </span>
                          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                            → {s.targetLang}
                          </span>
                          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                            {s.slideType}
                          </span>
                          <span className="text-[var(--faint)]">{fmtDate(s.createdAt)}</span>
                          <span className="inline-flex items-center gap-1 text-[var(--faint)]">
                            <Users size={12} /> {s.attendeeCount} joined · peak {s.peakViewers}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <Link to={`/${s.slug}/host`} className="btn-ghost rounded-lg px-3 py-1.5 text-xs">
                        Host
                      </Link>
                      <Link to={`/${s.slug}`} className="btn-ghost rounded-lg px-3 py-1.5 text-xs">
                        Viewer
                      </Link>
                      <Link to={`/${s.slug}/transcript`} className="btn-ghost rounded-lg px-3 py-1.5 text-xs">
                        Transcript
                      </Link>
                      <button onClick={() => startEdit(s)} className="btn-ghost rounded-lg px-3 py-1.5 text-xs">
                        Edit
                      </button>
                      {confirmDelete === s.slug ? (
                        <span className="flex items-center gap-2 text-xs">
                          <span className="text-error">Delete?</span>
                          <button
                            onClick={() => void doDelete(s.slug)}
                            disabled={busy}
                            className="rounded-[var(--r-md)] bg-error-soft px-3 py-1.5 font-medium text-error ring-1 ring-inset ring-error transition hover:brightness-110"
                          >
                            Yes, delete
                          </button>
                          <button onClick={() => setConfirmDelete(null)} className="btn-ghost rounded-lg px-3 py-1.5">
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => {
                            setEditing(null);
                            setConfirmDelete(s.slug);
                          }}
                          className="rounded-[var(--r-md)] px-3 py-1.5 text-xs text-error ring-1 ring-inset ring-error transition hover:bg-error-soft"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
