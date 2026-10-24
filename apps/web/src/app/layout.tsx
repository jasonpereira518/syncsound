import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { JetBrains_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import { SwRegister } from '@/components/SwRegister';
import './globals.css';

// Chillax (Fontshare, ITF Free Font License), self-hosted
const chillax = localFont({
  src: [
    { path: './fonts/Chillax-Regular.woff2', weight: '400' },
    { path: './fonts/Chillax-Medium.woff2', weight: '500' },
    { path: './fonts/Chillax-Semibold.woff2', weight: '600' },
    // the app uses font-bold; Chillax tops out at semibold here, so 700 maps to it instead of a faux bold
    { path: './fonts/Chillax-Semibold.woff2', weight: '700' },
  ],
  variable: '--font-chillax',
  display: 'swap',
});
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains-mono', display: 'swap' });

export const metadata: Metadata = {
  title: { default: 'SyncSound: every phone is a speaker', template: '%s · SyncSound' },
  description:
    'Turn every phone, laptop and tablet in the room into one synchronized, spatial speaker system. No app, just a link.',
  applicationName: 'SyncSound',
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
  appleWebApp: { capable: true, title: 'SyncSound', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  themeColor: '#0e0c0a',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${chillax.variable} ${mono.variable}`}>
      <body className="font-sans antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[100] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-3 focus:font-semibold focus:text-accent-ink"
        >
          Skip to content
        </a>
        {children}
        <SwRegister />
        <Analytics />
      </body>
    </html>
  );
}
