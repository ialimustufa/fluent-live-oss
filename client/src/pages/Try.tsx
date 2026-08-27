import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Globe, Lock, Sparkles } from 'lucide-react';
import { createTrial, fetchLanguages, type Language } from '../lib/api';
import { setTrialHostToken } from '../lib/trial';
import ThemeToggle from '../components/ThemeToggle';

export default function Try() {
  const navigate = useNavigate();
  const [languages, setLanguages] = useState<Language[]>([]);
  const [geminiKey, setGeminiKey] = useState('');
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

  useEffect(() => {
    void fetchLanguages().then(setLanguages);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('geminiApiKey', geminiKey.trim());
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
      const res = await createTrial(form);
      setTrialHostToken(res.slug, res.hostToken);
      navigate(res.hostPath);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-aurora relative min-h-screen px-4 py-6 sm:px-6 lg:py-8">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-[31rem] items-center pt-12 lg:pt-0">
        <form
          onSubmit={submit}
          className="animate-fade-up glass-panel w-full space-y-4 rounded-2xl border border-[var(--border-strong)] p-5 shadow-2xl sm:p-6"
        >
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-[var(--cyan)] ring-1 ring-inset ring-[var(--accent-ring)]">
              <Sparkles size={13} />
              Try it free
            </div>
            <h1 className="text-2xl font-bold text-[var(--fg)]">Start a test presentation</h1>
            <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
              Use your Gemini key for one <b className="font-semibold text-[var(--fg)]">15-minute</b>{' '}
              private trial with live translation, captions, slides, and{' '}
              <b className="font-semibold text-[var(--fg)]">10 viewers</b>.
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">Gemini API key</label>
            <input
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="Paste your key"
              className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
              autoComplete="off"
              required
            />
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
              <Lock size={12} className="mr-1 inline-block -translate-y-px align-middle" />
              Used only for this session, kept in server memory, never stored or logged. Get one at{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--cyan)] hover:underline"
              >
                aistudio.google.com/apikey
              </a>
              .
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">
              Talk title <span className="text-[var(--faint)]">(optional)</span>
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
              placeholder="My test talk"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">Audience language</label>
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
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">Presentation mode</label>
            <div className="mb-2 grid grid-cols-2 gap-1 rounded-xl bg-[var(--surface-2)] p-1 text-sm ring-1 ring-inset ring-[var(--border)]">
              {(['in_person', 'remote'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setPresentationMode(m)}
                  className={`rounded-lg px-2 py-2 font-semibold transition ${
                    presentationMode === m
                      ? 'grad-fill shadow-sm'
                      : 'text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {m === 'in_person' ? <Building2 size={16} /> : <Globe size={16} />}
                    {m === 'in_person' ? 'In-person' : 'Remote'}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              {presentationMode === 'in_person'
                ? 'Room PA audio; viewers see captions + slides (audio opt-in).'
                : 'Each viewer hears audio on their own device.'}
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">Slides</label>
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-[var(--surface-2)] p-1 text-xs ring-1 ring-inset ring-[var(--border)] sm:text-sm">
              {(['pdf', 'gslides', 'html'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setSlideType(t)}
                  className={`rounded-lg px-1.5 py-2 font-semibold transition ${
                    slideType === t
                      ? 'grad-fill shadow-sm'
                      : 'text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  {t === 'pdf' ? 'PDF' : t === 'gslides' ? 'Google Slides' : 'HTML deck'}
                </button>
              ))}
            </div>
            {slideType === 'pdf' && (
              <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)] ring-1 ring-inset ring-[var(--border)] transition hover:ring-[var(--border-strong)]">
                <span className="min-w-0 truncate">{file?.name ?? 'Choose a PDF file'}</span>
                <span className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold text-[var(--fg)] ring-1 ring-inset ring-[var(--border)]">
                  Browse
                </span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  className="sr-only"
                />
              </label>
            )}
            {slideType === 'gslides' && (
              <input
                value={slideUrl}
                onChange={(e) => setSlideUrl(e.target.value)}
                placeholder="https://docs.google.com/presentation/d/e/…/pub"
                className="input-field w-full px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
              />
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
                  Use an external HTTPS URL. Local HTML uploads are disabled for security.
                </p>
              </div>
            )}
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm font-semibold text-[var(--muted)] transition hover:text-[var(--fg)]"
            >
              {showAdvanced ? 'Hide advanced' : 'Show advanced'}
            </button>
            {showAdvanced && (
              <label className="mt-3 flex items-start gap-2.5 rounded-xl bg-[var(--surface-2)] p-3 text-sm text-[var(--muted)] ring-1 ring-inset ring-[var(--border)]">
                <input
                  type="checkbox"
                  checked={echoTarget}
                  onChange={(e) => setEchoTarget(e.target.checked)}
                  className="mt-0.5 accent-[var(--cyan)]"
                />
                <span>Echo target language when the speaker already uses the audience language.</span>
              </label>
            )}
          </div>

          {error && (
            <p className="rounded-[var(--r-md)] bg-error-soft px-3 py-2 text-sm text-error ring-1 ring-inset ring-error">
              {error}
            </p>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full rounded-xl py-3 text-base">
            {busy ? 'Starting…' : 'Start trial'}
          </button>
        </form>
      </div>
    </div>
  );
}
