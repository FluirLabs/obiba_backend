'use client';

import { useEffect, useState } from 'react';
import { IconClose, IconSearch } from './icons';
import { Button, cx } from './ui';

export function SearchField({ value, onCommit, placeholder, className, label = 'Search' }: { value: string; onCommit: (v: string) => void; placeholder: string; className?: string; label?: string }) {
  const [draft, setDraft] = useState(value);
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const t = window.setTimeout(() => onCommit(draft.trim()), 450);
    return () => window.clearTimeout(t);
  }, [draft, value, onCommit]);
  return (
    <div className={cx('relative min-w-[220px] flex-1', className)}>
      <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-subtle" />
      <input
        type="search"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommit(draft.trim());
          if (e.key === 'Escape' && draft) {
            e.stopPropagation();
            setDraft('');
            onCommit('');
          }
        }}
        placeholder={placeholder}
        className="h-8 w-full rounded-md border border-field bg-surface pr-8 pl-8 text-sm text-ink shadow-control placeholder:text-subtle hover:border-faint focus:border-brand focus:ring-3 focus:ring-brand/15 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {draft && (
        <button type="button" onClick={() => { setDraft(''); onCommit(''); }} className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded text-subtle hover:bg-wash hover:text-ink" aria-label="Clear search">
          <IconClose size={11} />
        </button>
      )}
    </div>
  );
}

export function ClearFilters({ active, onClear }: { active: boolean; onClear: () => void }) {
  if (!active) return null;
  return (
    <Button size="sm" variant="ghost" onClick={onClear}>
      Clear filters
    </Button>
  );
}
