import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Trash2 } from 'lucide-react';
import { useBot } from '../context/BotContext';

type LogFilter = 'all' | 'trades' | 'rejects' | 'warnings';

export const ScanLogView: React.FC = () => {
  const { logs, srcStats, handleProbe, handleClearLogs } = useBot();
  const [filter, setFilter] = useState<LogFilter>('all');
  const [isProbing, setIsProbing] = useState(false);
  const [stickToBottom, setStickToBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const filteredLogs = useMemo(() => {
    if (filter === 'all') return logs;
    if (filter === 'trades') return logs.filter((l) => l.tag === 'buy' || l.tag === 'sell' || l.tag === 'summary');
    if (filter === 'rejects') return logs.filter((l) => l.tag === 'reject');
    return logs.filter((l) => l.tag === 'warn');
  }, [logs, filter]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs, stickToBottom]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setStickToBottom(atBottom);
  };

  const onProbeClick = async () => {
    setIsProbing(true);
    try {
      await handleProbe();
    } finally {
      setIsProbing(false);
    }
  };

  const getTagColor = (tag: string) => {
    if (tag === 'buy') return 'text-[var(--green)] font-semibold';
    if (tag === 'sell') return 'text-[var(--blue)] font-semibold';
    if (tag === 'reject') return 'text-[var(--dim)]';
    if (tag === 'warn') return 'text-[var(--orange)] font-medium';
    if (tag === 'summary') return 'text-[var(--teal)] font-semibold';
    return 'text-[var(--text)]';
  };

  const sourceEntries = Object.entries(srcStats || {});

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 p-4 gap-3 bg-[var(--bg)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-1 p-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] text-xs">
          {([
            ['all', 'All'],
            ['trades', 'Buys & Sells'],
            ['rejects', 'Rug & Rejects'],
            ['warnings', 'Warnings'],
          ] as [LogFilter, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setFilter(id)}
              className={`px-3 py-1 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                filter === id
                  ? 'bg-[var(--card)] text-[var(--text)] border border-[var(--border-bright)]'
                  : 'text-[var(--muted)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Live Source Counters */}
        {sourceEntries.length > 0 && (
          <div className="hidden lg:flex items-center gap-2 text-xs font-mono text-[var(--muted)] tabular-nums">
            <span className="text-[var(--dim)]">Sources:</span>
            {sourceEntries.map(([name, info]: [string, any], idx) => (
              <React.Fragment key={name}>
                {idx > 0 && <span className="text-[var(--border-bright)]">·</span>}
                <span>
                  {name}={info?.items ?? 0}
                </span>
              </React.Fragment>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={onProbeClick}
            disabled={isProbing}
            className="px-3 py-1.5 rounded-lg border border-[var(--teal)]/50 bg-[var(--teal)]/10 text-[var(--teal)] hover:bg-[var(--teal)]/20 text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 whitespace-nowrap"
          >
            <Play size={12} />
            <span>{isProbing ? 'Probing...' : 'Probe market now'}</span>
          </button>

          <button
            type="button"
            onClick={handleClearLogs}
            className="px-3 py-1.5 rounded-lg border border-[var(--border-bright)] bg-[var(--card)] hover:bg-[var(--card-hover)] text-xs font-medium text-[var(--muted)] hover:text-[var(--text)] flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
          >
            <Trash2 size={12} />
            <span>Clear log</span>
          </button>
        </div>
      </div>

      {/* Scrollable Monospace Log Panel matching gui.py */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-auto bg-[var(--card)] border border-[var(--border)] rounded-lg p-3 font-mono text-xs leading-relaxed"
      >
        {filteredLogs.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[var(--dim)] text-xs font-sans">
            No scan log entries yet. Press &ldquo;Start bot&rdquo; or &ldquo;Probe market now&rdquo; to inspect candidate sources.
          </div>
        ) : (
          filteredLogs.map((entry) => (
            <div key={entry.id} className={`whitespace-pre ${getTagColor(entry.tag)}`}>
              {entry.line}
            </div>
          ))
        )}
      </div>
    </div>
  );
};
