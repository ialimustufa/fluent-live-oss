import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, Check, Globe } from 'lucide-react';
import { createSession, fetchLanguages, type Language } from '../lib/api';
import { getAdminKey } from '../lib/adminKey';
import AdminKeyGate from '../components/AdminKeyGate';
import QrCode from '../components/QrCode';
import ThemeToggle from '../components/ThemeToggle';

export default function NewSession() {
  return (
    <AdminKeyGate>
      <NewSessionInner />
    </AdminKeyGate>
  );
}

function NewSessionInner() {
  const [languages, setLanguages] = useState<Language[]>([]);
  const [title, setTitle] = useState('');
  const [targetLang, setTargetLang] = useState('es');
  const [presentationMode, setPresentationMode] = useState<'in_person' | 'remote'>('in_person');
  const [slideType, setSlideType] = useState<'pdf' | 'gslides' | 'html'>('pdf');
  const [file, setFile] = useState<File | null>(null);
  const [slideUrl, setSlideUrl] = useState('');
  const [echoTarget, setEchoTarget] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ slug: string; viewerPath: string; hostPath: string } | null>(null);

  useEffect(() => {
    void fetchLanguages().then(setLanguages);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('title', title);
      form.set('targetLang', targetLang);
      form.set('presentationMode', presentationMode);
      form.set('slideType', slideType);
      form.set('echoTargetLanguage', String(echoTarget));
      if (slideType === 'pdf') {
        if (!file) throw new Error('Choose a PDF file.');
        form.set('file', file);
      } else {
        if (!slideUrl) throw new Error('Enter a URL.');
        form.set('slideUrl', slideUrl);
      }
      setCreated(await createSession(getAdminKey() ?? '', form));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    const viewerUrl = `${location.origin}${created.viewerPath}`;
    return (
      <div className="bg-aurora relative flex min-h-screen items-start justify-center px-6 pb-6 pt-20 sm:items-center sm:p-6">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
        <div className="animate-fade-up glass-panel grad-border w-full max-w-md space-y-5 rounded-3xl p-8 text-center shadow-2xl">
          <div className="grad-fill mx-auto flex h-12 w-12 items-center justify-center rounded-2xl">
            <Check size={24} strokeWidth={2.25} />
          </div>
          <h1 className="text-xl font-semibold text-[var(--fg)]">Session ready</h1>
          <div className="flex justify-center">
            <QrCode url={viewerUrl} size={200} />
          </div>
          <div className="text-left">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">
              Audience URL — share or project the QR
            </p>
            <div className="flex gap-2">
              <input readOnly value={viewerUrl} className="input-field min-w-0 flex-1 px-3 py-2 text-sm" />
              <button
                onClick={() => void navigator.clipboard.writeText(viewerUrl)}
                className="btn-ghost rounded-xl px-4 py-2 text-sm"
              >
                Copy
              </button>
            </div>
          </div>
          <Link to={created.hostPath} className="btn-primary block w-full rounded-xl py-3">
            Open host console
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-aurora relative flex min-h-screen items-start justify-center px-6 pb-6 pt-20 sm:items-center sm:p-6">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <form
        onSubmit={submit}
        className="animate-fade-up glass-panel grad-border w-full max-w-md space-y-5 rounded-3xl p-8 shadow-2xl"
      >
        <div>
          <h1 className="text-2xl font-bold text-[var(--fg)]">New presentation</h1>
          <p className="mt-1 text-sm text-[var(--faint)]">Set your audience's language and slides.</p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Talk title <span className="text-[var(--faint)]">(optional)</span></label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
            placeholder="My conference talk"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Audience language</label>
          <select
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value)}
            className="input-field w-full px-4 py-2.5 text-[var(--fg)]"
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code} className="bg-[var(--surface)]">
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Presentation mode</label>
          <div className="mb-2 flex gap-1 rounded-xl bg-[var(--surface-2)] p-1 text-sm ring-1 ring-inset ring-[var(--border)]">
            {(['in_person', 'remote'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPresentationMode(m)}
                className={`flex-1 rounded-lg py-2 font-medium transition ${
                  presentationMode === m
                    ? 'grad-fill shadow-sm'
                    : 'text-[var(--faint)] hover:text-[var(--muted)]'
                }`}
              >
                <span className="flex items-center justify-center gap-1.5">
                  {m === 'in_person' ? <Building2 size={16} /> : <Globe size={16} />}
                  {m === 'in_person' ? 'In-person' : 'Remote'}
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-[var(--faint)]">
            {presentationMode === 'in_person'
              ? 'Audio plays through the room PA (your laptop output); viewers see captions + slides on their phones (audio is an opt-in). Use the /present view to project.'
              : 'Each viewer hears the translated audio on their own device. Best for online/hybrid audiences.'}
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-[var(--muted)]">Slides</label>
          <div className="mb-3 flex gap-1 rounded-xl bg-[var(--surface-2)] p-1 text-sm ring-1 ring-inset ring-[var(--border)]">
            {(['pdf', 'gslides', 'html'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSlideType(t)}
                className={`flex-1 rounded-lg py-2 font-medium transition ${
                  slideType === t
                    ? 'grad-fill shadow-sm'
                    : 'text-[var(--faint)] hover:text-[var(--muted)]'
                }`}
              >
                {t === 'pdf' ? 'PDF' : t === 'gslides' ? 'Google Slides' : 'HTML deck'}
              </button>
            ))}
          </div>

          {slideType === 'pdf' && (
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm text-[var(--muted)] file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-[var(--surface-2)] file:px-4 file:py-2 file:font-medium file:text-[var(--fg)] hover:file:bg-[var(--surface-2)]"
            />
          )}
          {slideType === 'gslides' && (
            <div className="space-y-1.5">
              <input
                value={slideUrl}
                onChange={(e) => setSlideUrl(e.target.value)}
                placeholder="https://docs.google.com/presentation/d/e/…/pub"
                className="input-field w-full px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
              />
              <p className="text-xs leading-relaxed text-[var(--faint)]">
                Deck must be <b className="text-[var(--muted)]">published to the web</b>. Slide changes
                reload the embed with a visible flicker — export to PDF for the smoothest experience.
              </p>
            </div>
          )}
          {slideType === 'html' && (
            <div className="space-y-2">
              <input
                value={slideUrl}
                onChange={(e) => setSlideUrl(e.target.value)}
                placeholder="https://my-deck.example.com"
                className="input-field w-full px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
              />
              <p className="text-xs leading-relaxed text-[var(--faint)]">
                Decks can implement the sync protocol: listen for{' '}
                <code className="text-[var(--muted)]">{'{type:"goto", index}'}</code> and post back{' '}
                <code className="text-[var(--muted)]">{'{type:"slideCount", n}'}</code>. Use an external
                HTTPS URL; local HTML uploads are disabled for security.
              </p>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm font-medium text-[var(--faint)] transition hover:text-[var(--muted)]"
        >
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <label className="flex items-start gap-2.5 rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
            <input
              type="checkbox"
              checked={echoTarget}
              onChange={(e) => setEchoTarget(e.target.checked)}
              className="mt-0.5 accent-[var(--cyan)]"
            />
            <span>
              <b className="text-[var(--muted)]">Echo target language</b> — if on, speech already in the
              audience language is repeated by the translator (off avoids doubled audio).
            </span>
          </label>
        )}

        {error && <p className="rounded-[var(--r-md)] bg-error-soft px-3 py-2 text-sm text-error ring-1 ring-inset ring-error">{error}</p>}

        <button type="submit" disabled={busy} className="btn-primary w-full rounded-xl py-3 text-base">
          {busy ? 'Creating…' : 'Create session'}
        </button>
      </form>
    </div>
  );
}
