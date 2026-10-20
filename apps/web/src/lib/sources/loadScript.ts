const loading = new Map<string, Promise<void>>();

/** Inject a third-party SDK script once. */
export function loadScript(src: string): Promise<void> {
  let p = loading.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loading.delete(src);
        reject(new Error(`Couldn't load ${new URL(src).hostname} (blocked or offline).`));
      };
      document.head.appendChild(s);
    });
    loading.set(src, p);
  }
  return p;
}
