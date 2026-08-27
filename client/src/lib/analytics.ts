declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    doNotTrack?: string;
  }

  interface Navigator {
    globalPrivacyControl?: boolean;
    msDoNotTrack?: string;
  }
}

const measurementId = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim() ?? '';

let initialized = false;
let lastTrackedPath: string | null = null;

function privacyOptedOut(): boolean {
  const dnt = navigator.doNotTrack ?? window.doNotTrack ?? navigator.msDoNotTrack;
  return navigator.globalPrivacyControl === true || dnt === '1' || dnt?.toLowerCase() === 'yes';
}

function categoryForPath(pathname: string): string {
  if (pathname === '/') return 'home';
  if (pathname === '/new') return 'new';
  if (pathname === '/admin') return 'admin';
  if (/^\/[^/]+\/host$/.test(pathname)) return 'host';
  if (/^\/[^/]+\/present$/.test(pathname)) return 'present';
  if (/^\/[^/]+\/transcript$/.test(pathname)) return 'transcript';
  if (/^\/[^/]+$/.test(pathname)) return 'viewer';
  return 'other';
}

function canonicalPath(pathname: string): string {
  // Retired marketing entry points redirect home. Canonicalize before the
  // duplicate check so the legacy URL and its immediate redirect emit one
  // home page-view rather than a short-lived viewer page-view followed by home.
  return pathname === '/try' || pathname === '/beta' ? '/' : pathname;
}

function initAnalytics(): boolean {
  if (!measurementId || privacyOptedOut()) return false;
  if (initialized) return true;

  window.dataLayer = window.dataLayer ?? [];
  window.gtag = (...args: unknown[]) => {
    window.dataLayer?.push(args);
  };
  window.gtag('js', new Date());
  window.gtag('config', measurementId, {
    send_page_view: false,
    anonymize_ip: true,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  document.head.appendChild(script);
  initialized = true;
  return true;
}

export function trackRoute(pathname: string): void {
  const canonical = canonicalPath(pathname);
  if (lastTrackedPath === canonical) return;
  lastTrackedPath = canonical;
  if (!initAnalytics() || !window.gtag) return;

  const category = categoryForPath(canonical);
  window.gtag('event', 'page_view', {
    page_title: document.title,
    page_location: `${window.location.origin}/${category}`,
    page_path: `/${category}`,
    fluent_page_category: category,
  });
}
