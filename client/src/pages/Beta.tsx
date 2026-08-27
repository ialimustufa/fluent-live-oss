import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Building2, Globe, Lock, Sparkles } from 'lucide-react';
import { createBetaTrial, createTrial, fetchLanguages, type Language } from '../lib/api';
import { setTrialHostToken } from '../lib/trial';
import ThemeToggle from '../components/ThemeToggle';

const BETA_PDF_MAX_BYTES = 5 * 1024 * 1024;
const BUDGET_OPTIONS = [
  'Not sure yet',
  'Under $25/hour',
  '$25-$50/hour',
  '$50-$100/hour',
  '$100-$150/hour',
  '$150+/hour',
];

type BetaField = 'fullName' | 'email' | 'company' | 'budget' | 'geminiKey' | 'targetLang' | 'slideFile' | 'slideUrl';

const FIELD_LABELS: Record<BetaField, string> = {
  fullName: 'full name',
  email: 'work email',
  company: 'company',
  budget: 'budget',
  geminiKey: 'Gemini API key',
  targetLang: 'audience language',
  slideFile: 'PDF file',
  slideUrl: 'slide URL',
};

function fieldErrorId(field: BetaField): string {
  return `beta-${field}-error`;
}

function classifyBetaFieldError(message: string): BetaField | null {
  const lower = message.toLowerCase();
  if (lower.includes('email') || lower.includes('beta trial has already been used')) return 'email';
  if (lower.includes('full name')) return 'fullName';
  if (lower.includes('company')) return 'company';
  if (lower.includes('budget')) return 'budget';
  if (lower.includes('pdf') || lower.includes('upload') || lower.includes('file')) return 'slideFile';
  if (lower.includes('url') || lower.includes('gslides') || lower.includes('html')) return 'slideUrl';
  if (lower.includes('gemini') || lower.includes('api key')) return 'geminiKey';
  if (lower.includes('audience language') || lower.includes('target language') || lower.includes('unsupported target language')) {
    return 'targetLang';
  }
  return null;
}

export default function Beta() {
  const navigate = useNavigate();
  const fullNameInputRef = useRef<HTMLInputElement | null>(null);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const companyInputRef = useRef<HTMLInputElement | null>(null);
  const budgetSelectRef = useRef<HTMLSelectElement | null>(null);
  const geminiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const targetLangSelectRef = useRef<HTMLSelectElement | null>(null);
  const slideFileControlRef = useRef<HTMLLabelElement | null>(null);
  const slideUrlInputRef = useRef<HTMLInputElement | null>(null);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [geminiKey, setGeminiKey] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [budget, setBudget] = useState(BUDGET_OPTIONS[0]);
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
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<BetaField, string>>>({});

  useEffect(() => {
    void fetchLanguages().then(setLanguages);
  }, []);

  const fieldError = (field: BetaField) => fieldErrors[field] ?? null;
  const invalid = (field: BetaField) => (fieldError(field) ? 'true' : undefined);

  const fieldElement = (field: BetaField): HTMLElement | null => {
    switch (field) {
      case 'fullName':
        return fullNameInputRef.current;
      case 'email':
        return emailInputRef.current;
      case 'company':
        return companyInputRef.current;
      case 'budget':
        return budgetSelectRef.current;
      case 'geminiKey':
        return geminiKeyInputRef.current;
      case 'targetLang':
        return targetLangSelectRef.current;
      case 'slideFile':
        return slideFileControlRef.current;
      case 'slideUrl':
        return slideUrlInputRef.current;
    }
  };

  const focusField = (field: BetaField) => {
    requestAnimationFrame(() => {
      const element = fieldElement(field);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus({ preventScroll: true });
    });
  };

  const reportFieldError = (field: BetaField, message: string) => {
    setFieldErrors({ [field]: message });
    setError(`Check the highlighted ${FIELD_LABELS[field]} field.`);
    focusField(field);
  };

  const clearFieldError = (field: BetaField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    if (error?.startsWith('Check the highlighted ')) setError(null);
  };

  const validateClientFields = (ownKey: string): { field: BetaField; message: string } | null => {
    if (fullName.trim().length < 2) return { field: 'fullName', message: 'Full name is required.' };
    if (!email.trim() || !emailInputRef.current?.validity.valid) {
      return { field: 'email', message: 'Enter a valid work email address.' };
    }
    if (company.trim().length < 2) return { field: 'company', message: 'Company is required.' };
    if (!BUDGET_OPTIONS.includes(budget)) return { field: 'budget', message: 'Choose a valid budget range.' };
    if (languages.length > 0 && !languages.some((language) => language.code === targetLang)) {
      return { field: 'targetLang', message: 'Choose an audience language.' };
    }
    if (slideType === 'pdf') {
      if (!file) return { field: 'slideFile', message: 'Choose a PDF file.' };
      if (!ownKey && file.size > BETA_PDF_MAX_BYTES) {
        return {
          field: 'slideFile',
          message: 'Hosted beta PDF uploads must be 5 MB or smaller. Add your Gemini key to use the self-serve trial limits.',
        };
      }
    } else if (!slideUrl.trim()) {
      return { field: 'slideUrl', message: 'Enter a URL.' };
    }
    return null;
  };

  const chooseFile = (next: File | null, input?: HTMLInputElement) => {
    setError(null);
    clearFieldError('slideFile');
    if (!geminiKey.trim() && next && next.size > BETA_PDF_MAX_BYTES) {
      setFile(null);
      if (input) input.value = '';
      reportFieldError(
        'slideFile',
        'Hosted beta PDF uploads must be 5 MB or smaller. Add your Gemini key to use the self-serve trial limits.'
      );
      return;
    }
    setFile(next);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const ownKey = geminiKey.trim();
      const localError = validateClientFields(ownKey);
      if (localError) {
        reportFieldError(localError.field, localError.message);
        return;
      }
      const form = new FormData();
      if (ownKey) form.set('geminiApiKey', ownKey);
      form.set('fullName', fullName);
      form.set('email', email);
      form.set('company', company);
      form.set('budget', budget);
      form.set('title', title);
      form.set('targetLang', targetLang);
      form.set('presentationMode', presentationMode);
      form.set('slideType', slideType);
      form.set('echoTargetLanguage', String(echoTarget));
      if (slideType === 'pdf') {
        form.set('file', file!);
      } else {
        form.set('slideUrl', slideUrl);
      }
      const res = ownKey ? await createTrial(form) : await createBetaTrial(form);
      setTrialHostToken(res.slug, res.hostToken);
      navigate(res.hostPath);
    } catch (err) {
      const message = String((err as Error).message ?? err);
      const field = classifyBetaFieldError(message);
      if (field) {
        reportFieldError(field, message);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-aurora min-h-screen px-4 py-6 sm:px-6 lg:py-8">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
        <Link
          to="/"
          className="btn-ghost inline-flex items-center gap-1.5 rounded-[var(--r-md)] px-3 py-2 text-sm font-medium"
        >
          <ArrowLeft size={16} /> Home
        </Link>
        <ThemeToggle />
      </div>

      <main className="mx-auto mt-6 grid w-full max-w-5xl gap-5 lg:grid-cols-[minmax(0,31rem)_minmax(18rem,24rem)] lg:gap-8">
        <form
          onSubmit={submit}
          noValidate
          className="animate-fade-up glass-panel w-full space-y-4 rounded-2xl border border-[var(--border-strong)] p-5 shadow-2xl sm:p-6"
        >
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold text-[var(--cyan)] ring-1 ring-inset ring-[var(--accent-ring)]">
              <Sparkles size={13} />
              Hosted beta trial
            </div>
            <h1 className="text-2xl font-bold text-[var(--fg)]">Start a 2-minute beta trial</h1>
            <p className="mt-1 text-sm leading-relaxed text-[var(--muted)]">
              No API key needed. Add your Gemini key for a{' '}
              <b className="font-semibold text-[var(--fg)]">15-minute</b> self-serve trial. Both support up to{' '}
              <b className="font-semibold text-[var(--fg)]">10 viewers</b>.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={`mb-1.5 block text-sm font-semibold ${fieldError('fullName') ? 'text-error' : 'text-[var(--fg)]'}`}>
                Full name
              </label>
              <input
                ref={fullNameInputRef}
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  clearFieldError('fullName');
                }}
                className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
                autoComplete="name"
                aria-invalid={invalid('fullName')}
                aria-describedby={fieldError('fullName') ? fieldErrorId('fullName') : undefined}
                required
              />
              {fieldError('fullName') && (
                <p id={fieldErrorId('fullName')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                  {fieldError('fullName')}
                </p>
              )}
            </div>
            <div>
              <label className={`mb-1.5 block text-sm font-semibold ${fieldError('email') ? 'text-error' : 'text-[var(--fg)]'}`}>
                Work email
              </label>
              <input
                ref={emailInputRef}
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearFieldError('email');
                }}
                className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
                autoComplete="email"
                aria-invalid={invalid('email')}
                aria-describedby={fieldError('email') ? fieldErrorId('email') : undefined}
                required
              />
              {fieldError('email') && (
                <p id={fieldErrorId('email')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                  {fieldError('email')}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={`mb-1.5 block text-sm font-semibold ${fieldError('company') ? 'text-error' : 'text-[var(--fg)]'}`}>
                Company
              </label>
              <input
                ref={companyInputRef}
                value={company}
                onChange={(e) => {
                  setCompany(e.target.value);
                  clearFieldError('company');
                }}
                className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
                autoComplete="organization"
                aria-invalid={invalid('company')}
                aria-describedby={fieldError('company') ? fieldErrorId('company') : undefined}
                required
              />
              {fieldError('company') && (
                <p id={fieldErrorId('company')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                  {fieldError('company')}
                </p>
              )}
            </div>
            <div>
              <label className={`mb-1.5 block text-sm font-semibold ${fieldError('budget') ? 'text-error' : 'text-[var(--fg)]'}`}>
                Budget
              </label>
              <select
                ref={budgetSelectRef}
                value={budget}
                onChange={(e) => {
                  setBudget(e.target.value);
                  clearFieldError('budget');
                }}
                className="input-field w-full px-4 py-2.5 text-[var(--fg)]"
                aria-invalid={invalid('budget')}
                aria-describedby={fieldError('budget') ? fieldErrorId('budget') : undefined}
              >
                {BUDGET_OPTIONS.map((option) => (
                  <option key={option} value={option} className="bg-[var(--surface)]">
                    {option}
                  </option>
                ))}
              </select>
              {fieldError('budget') && (
                <p id={fieldErrorId('budget')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                  {fieldError('budget')}
                </p>
              )}
            </div>
          </div>

          <div>
            <label className={`mb-1.5 block text-sm font-semibold ${fieldError('geminiKey') ? 'text-error' : 'text-[var(--fg)]'}`}>
              Gemini API key <span className="text-[var(--faint)]">(optional)</span>
            </label>
            <input
              ref={geminiKeyInputRef}
              type="password"
              value={geminiKey}
              onChange={(e) => {
                setGeminiKey(e.target.value);
                setError(null);
                clearFieldError('geminiKey');
              }}
              placeholder="Paste your key for a 15-minute trial"
              className="input-field w-full px-4 py-2.5 text-[var(--fg)] placeholder:text-[var(--faint)]"
              autoComplete="off"
              aria-invalid={invalid('geminiKey')}
              aria-describedby={fieldError('geminiKey') ? fieldErrorId('geminiKey') : undefined}
            />
            {fieldError('geminiKey') && (
              <p id={fieldErrorId('geminiKey')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                {fieldError('geminiKey')}
              </p>
            )}
            <p className="mt-1.5 text-xs leading-relaxed text-[var(--muted)]">
              <Lock size={12} className="mr-1 inline-block -translate-y-px align-middle" />
              Optional. Used only for this session, kept in server memory, never stored or logged. Get one at{' '}
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
              placeholder="My beta trial"
            />
          </div>

          <div>
            <label className={`mb-1.5 block text-sm font-semibold ${fieldError('targetLang') ? 'text-error' : 'text-[var(--fg)]'}`}>
              Audience language
            </label>
            <select
              ref={targetLangSelectRef}
              value={targetLang}
              onChange={(e) => {
                setTargetLang(e.target.value);
                clearFieldError('targetLang');
              }}
              className="input-field w-full px-4 py-2.5 text-[var(--fg)]"
              aria-invalid={invalid('targetLang')}
              aria-describedby={fieldError('targetLang') ? fieldErrorId('targetLang') : undefined}
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code} className="bg-[var(--surface)]">
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            {fieldError('targetLang') && (
              <p id={fieldErrorId('targetLang')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                {fieldError('targetLang')}
              </p>
            )}
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
                    presentationMode === m ? 'grad-fill shadow-sm' : 'text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {m === 'in_person' ? <Building2 size={16} /> : <Globe size={16} />}
                    {m === 'in_person' ? 'In-person' : 'Remote'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-semibold text-[var(--fg)]">Slides</label>
            <div className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-[var(--surface-2)] p-1 text-xs ring-1 ring-inset ring-[var(--border)] sm:text-sm">
              {(['pdf', 'gslides', 'html'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setSlideType(t);
                    setError(null);
                    clearFieldError('slideFile');
                    clearFieldError('slideUrl');
                  }}
                  className={`rounded-lg px-1.5 py-2 font-semibold transition ${
                    slideType === t ? 'grad-fill shadow-sm' : 'text-[var(--muted)] hover:text-[var(--fg)]'
                  }`}
                >
                  {t === 'pdf' ? 'PDF' : t === 'gslides' ? 'Google Slides' : 'HTML deck'}
                </button>
              ))}
            </div>
            {slideType === 'pdf' && (
              <label
                ref={slideFileControlRef}
                tabIndex={-1}
                aria-invalid={invalid('slideFile')}
                aria-describedby={fieldError('slideFile') ? fieldErrorId('slideFile') : undefined}
                className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl bg-[var(--surface)] px-3 py-2 text-sm ring-1 ring-inset transition ${
                  fieldError('slideFile')
                    ? 'text-error ring-error shadow-[0_0_0_3px_var(--error-ring)]'
                    : 'text-[var(--muted)] ring-[var(--border)] hover:ring-[var(--border-strong)]'
                }`}
              >
                <span className="min-w-0 truncate">
                  {file?.name ?? 'Choose a PDF file (5 MB max without a key)'}
                </span>
                <span className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-xs font-semibold text-[var(--fg)] ring-1 ring-inset ring-[var(--border)]">
                  Browse
                </span>
                <input
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => chooseFile(e.target.files?.[0] ?? null, e.currentTarget)}
                  className="sr-only"
                />
              </label>
            )}
            {fieldError('slideFile') && (
              <p id={fieldErrorId('slideFile')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                {fieldError('slideFile')}
              </p>
            )}
            {slideType === 'gslides' && (
              <input
                ref={slideUrlInputRef}
                value={slideUrl}
                onChange={(e) => {
                  setSlideUrl(e.target.value);
                  clearFieldError('slideUrl');
                }}
                placeholder="https://docs.google.com/presentation/d/e/.../pub"
                className="input-field w-full px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
                aria-invalid={invalid('slideUrl')}
                aria-describedby={fieldError('slideUrl') ? fieldErrorId('slideUrl') : undefined}
              />
            )}
            {slideType === 'html' && (
              <div className="space-y-2">
                <input
                  ref={slideUrlInputRef}
                  value={slideUrl}
                  onChange={(e) => {
                    setSlideUrl(e.target.value);
                    clearFieldError('slideUrl');
                  }}
                  placeholder="https://my-deck.example.com"
                  className="input-field w-full px-4 py-2.5 text-sm text-[var(--fg)] placeholder:text-[var(--faint)]"
                  aria-invalid={invalid('slideUrl')}
                  aria-describedby={fieldError('slideUrl') ? fieldErrorId('slideUrl') : undefined}
                />
                {fieldError('slideUrl') && (
                  <p id={fieldErrorId('slideUrl')} className="text-xs font-medium leading-relaxed text-error">
                    {fieldError('slideUrl')}
                  </p>
                )}
                <p className="text-xs leading-relaxed text-[var(--faint)]">
                  Use an external HTTPS URL. Local HTML uploads are disabled for security.
                </p>
              </div>
            )}
            {slideType === 'gslides' && fieldError('slideUrl') && (
              <p id={fieldErrorId('slideUrl')} className="mt-1.5 text-xs font-medium leading-relaxed text-error">
                {fieldError('slideUrl')}
              </p>
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
            {busy ? 'Starting...' : geminiKey.trim() ? 'Start 15-minute trial' : 'Start beta trial'}
          </button>
        </form>

        <aside className="animate-fade-up glass-panel h-fit rounded-2xl p-5 text-[var(--fg)] shadow-xl">
          <p className="grad-text text-xs font-bold uppercase tracking-widest">Trial limits</p>
          <div className="mt-4 grid gap-2 text-sm">
            <div className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-3 py-2 ring-1 ring-inset ring-[var(--border)]">
              <span className="font-semibold text-[var(--fg)]">2 minutes hosted</span>
              <span className="block text-xs text-[var(--muted)]">Add your key for 15 minutes.</span>
            </div>
            <div className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-3 py-2 ring-1 ring-inset ring-[var(--border)]">
              <span className="font-semibold text-[var(--fg)]">10 viewers</span>
              <span className="block text-xs text-[var(--muted)]">Same audience cap with or without your key.</span>
            </div>
            <div className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-3 py-2 ring-1 ring-inset ring-[var(--border)]">
              <span className="font-semibold text-[var(--fg)]">Optional Gemini key</span>
              <span className="block text-xs text-[var(--muted)]">
                Session-only. Never stored or logged.
              </span>
            </div>
          </div>
        </aside>
      </main>

    </div>
  );
}
