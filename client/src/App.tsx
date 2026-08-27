import { useEffect } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import NewSession from './pages/NewSession';
import Host from './pages/Host';
import Viewer from './pages/Viewer';
import TranscriptPage from './pages/TranscriptPage';
import AdminDashboard from './pages/AdminDashboard';
import Try from './pages/Try';
import Present from './pages/Present';
import Beta from './pages/Beta';
import ThemeToggle from './components/ThemeToggle';
import { trackRoute } from './lib/analytics';

function AnalyticsRouteTracker() {
  const location = useLocation();
  useEffect(() => {
    trackRoute(location.pathname);
  }, [location.pathname]);
  return null;
}

function LegacyResourceRedirect() {
  const { slug = '' } = useParams();
  return <Navigate replace to={slug ? `/${encodeURIComponent(slug)}` : '/'} />;
}

function Home() {
  return (
    <div className="bg-aurora relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="animate-fade-up flex flex-col items-center">
        <div className="grad-border mb-6 flex items-center gap-2.5 rounded-full px-4 py-1.5 text-xs font-medium text-[var(--fg)]">
          <span className="live-dot" />
          Real-time AI translation
        </div>
        <h1 className="grad-text text-6xl font-extrabold sm:text-7xl">
          Fluent
        </h1>
        <p className="mt-4 text-base font-medium text-[var(--fg)]">Instantly fluent in every language.</p>
        <p className="mt-3 max-w-md text-lg leading-relaxed text-[var(--muted)]">
          Present in English. Your audience hears and reads it live in their own language —
          translated audio, dual transcripts, and synced slides.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/beta"
            className="btn-primary flex items-center gap-2 rounded-[var(--r-lg)] px-8 py-3 text-base"
          >
            <Sparkles size={18} /> Start beta trial
          </Link>
        </div>
        <p className="mt-5 text-sm text-[var(--muted)]">Add your Gemini key in the trial form for longer testing.</p>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AnalyticsRouteTracker />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/beta" element={<Beta />} />
        <Route path="/new" element={<NewSession />} />
        <Route path="/try" element={<Try />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/:slug" element={<Viewer />} />
        <Route path="/:slug/host" element={<Host />} />
        <Route path="/:slug/present" element={<Present />} />
        <Route path="/:slug/resource" element={<LegacyResourceRedirect />} />
        <Route path="/resource/:slug" element={<LegacyResourceRedirect />} />
        <Route path="/:slug/transcript" element={<TranscriptPage />} />
      </Routes>
    </BrowserRouter>
  );
}
