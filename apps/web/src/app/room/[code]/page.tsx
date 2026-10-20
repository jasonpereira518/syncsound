import type { Metadata } from 'next';
import { RoomApp } from '@/components/room/RoomApp';

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  return { title: `Room ${code.toUpperCase()}` };
}

export default async function RoomPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <RoomApp code={code.toUpperCase()} />;
}
