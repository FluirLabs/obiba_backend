'use client';

import { Suspense, type ReactNode } from 'react';
import { AppShell } from '@/components/shell';

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<div className="min-h-dvh bg-canvas" />}>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
