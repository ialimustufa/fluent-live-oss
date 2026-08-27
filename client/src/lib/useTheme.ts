import { useEffect, useState } from 'react';

type Pref = 'light' | 'dark' | 'system';
const KEY = 'fluent.theme';

function getStored(): Pref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Apply the preference to <html> (matches the inline boot script in index.html). */
export function applyTheme(pref: Pref): void {
  const el = document.documentElement;
  el.classList.remove('light-theme', 'dark-theme');
  if (pref === 'light') el.classList.add('light-theme');
  else if (pref === 'dark') el.classList.add('dark-theme');
  // 'system' → no class; CSS prefers-color-scheme handles it.
}

export function useTheme() {
  const [pref, setPref] = useState<Pref>(getStored);
  const [effective, setEffective] = useState<'light' | 'dark'>(() =>
    pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref
  );

  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* ignore */
    }
    setEffective(pref === 'system' ? (systemDark() ? 'dark' : 'light') : pref);
  }, [pref]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => {
      if (getStored() === 'system') setEffective(mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  // Manual toggle flips to the explicit opposite of what's showing.
  const toggle = () => setPref(effective === 'dark' ? 'light' : 'dark');

  return { effective, pref, setPref, toggle };
}
