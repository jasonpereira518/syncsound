import type { Metadata } from 'next';
import { HomeApp } from '@/components/HomeApp';

export const metadata: Metadata = { title: 'Your home' };

export default async function HomePage({ params }: { params: Promise<{ homeId: string }> }) {
  const { homeId } = await params;
  return <HomeApp homeId={homeId} />;
}
