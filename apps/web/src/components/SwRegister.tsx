'use client';
import { useEffect } from 'react';

/** Registers the minimal app-shell service worker (production only; dev HMR and SWs don't mix). */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
