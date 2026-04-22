// Pure log-store helpers — no Electron, no fs. Just data transformations.
// Kept separate from `log-store.ts` so unit tests don't need to load `electron`.

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

/** Which subsystem produced this entry. */
export type LogSource = 'scheduler' | 'engagements';

export interface LogEntry {
  /** ISO 8601 timestamp. */
  ts: string;
  level: LogLevel;
  message: string;
  /** Which subsystem produced this entry. */
  source?: LogSource;
  durationMs?: number;
  matchedCount?: number;
  updatedCount?: number;
  failedCount?: number;
  /** IDs of records the run touched (matched / updated / would-have-updated). */
  recordIds?: string[];
  /** Stable identifier so the UI can group entries belonging to the same run. */
  runId?: string;
}

export type LogWindow = 'last-run' | '3d' | '7d' | '15d' | '30d';

export const RETENTION_DAYS = 30;

/**
 * Filter a newest-first array of entries to the requested window.
 */
export function filterByWindow(
  entries: LogEntry[],
  window: LogWindow,
  now: Date = new Date()
): LogEntry[] {
  if (entries.length === 0) return [];

  if (window === 'last-run') {
    const newest = entries[0];
    const targetRunId = newest.runId;
    if (!targetRunId) return [newest];
    return entries.filter((e) => e.runId === targetRunId);
  }

  const days = { '3d': 3, '7d': 7, '15d': 15, '30d': 30 }[window];
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  return entries.filter((e) => Date.parse(e.ts) >= cutoffMs);
}

/**
 * Parse JSONL text into entries (newest-first). Skips malformed lines silently
 * to keep the app working even if the file gets corrupted somehow.
 */
export function parseJsonl(text: string): LogEntry[] {
  if (!text) return [];
  const entries: LogEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as LogEntry;
      if (typeof parsed.ts === 'string' && typeof parsed.message === 'string') {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed line.
    }
  }
  // Sort newest-first (descending by timestamp).
  entries.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return entries;
}

/** Drop entries older than RETENTION_DAYS. */
export function pruneOld(entries: LogEntry[], now: Date = new Date()): LogEntry[] {
  const cutoffMs = now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return entries.filter((e) => Date.parse(e.ts) >= cutoffMs);
}

/** Serialize entries (oldest-first) back to JSONL text for rewriting the file. */
export function serializeJsonl(entries: LogEntry[]): string {
  if (entries.length === 0) return '';
  const ordered = [...entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return ordered.map((e) => JSON.stringify(e)).join('\n') + '\n';
}