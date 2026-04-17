// File-backed log store. Thin wrapper around log-store-core that adds the
// Electron-aware bits: file paths and disk I/O. The pure data logic lives in
// log-store-core.ts so it can be unit-tested without loading Electron.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  filterByWindow,
  LogEntry,
  LogWindow,
  parseJsonl,
  pruneOld,
  serializeJsonl,
} from './log-store-core';

export type { LogEntry, LogLevel, LogWindow } from './log-store-core';

const LOG_FILENAME = 'logs.jsonl';

export function getLogPath(): string {
  return path.join(app.getPath('userData'), LOG_FILENAME);
}

/** Append a log entry to disk. Cheap — single appendFile call. */
export function appendLog(entry: LogEntry): void {
  const p = getLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8');
}

/** Read all entries within a given window, newest-first. Lazily prunes >30d entries. */
export function readLogs(window: LogWindow): LogEntry[] {
  const all = readAndPruneAll();
  return filterByWindow(all, window);
}

/** Number of entries currently on disk (after pruning). For diagnostic display. */
export function countLogs(): number {
  return readAndPruneAll().length;
}

// ============ Internal: read + prune in one pass ============

function readAndPruneAll(): LogEntry[] {
  const p = getLogPath();
  if (!fs.existsSync(p)) return [];

  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch {
    return [];
  }

  const entries = parseJsonl(text);
  const kept = pruneOld(entries);

  // If we dropped any entries, rewrite the file with only the kept ones.
  // Write oldest-first (chronological) so future appends maintain order.
  if (kept.length < entries.length) {
    try {
      fs.writeFileSync(p, serializeJsonl(kept), 'utf8');
    } catch {
      // Worst case: a rewrite failed but we still return the in-memory pruned view.
    }
  }

  return kept;
}