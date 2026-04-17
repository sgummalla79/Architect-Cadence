import { describe, test, expect } from 'vitest';
import { filterByWindow, LogEntry, parseJsonl, pruneOld } from '../log-store-core';

function entry(overrides: Partial<LogEntry>): LogEntry {
  return {
    ts: '2026-04-17T12:00:00.000Z',
    level: 'info',
    message: 'msg',
    ...overrides,
  };
}

const NOW = new Date('2026-04-17T15:00:00.000Z');

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe('parseJsonl', () => {
  test('empty string returns []', () => {
    expect(parseJsonl('')).toEqual([]);
  });

  test('parses one entry per line', () => {
    const input =
      JSON.stringify(entry({ ts: daysAgo(1), message: 'a' })) +
      '\n' +
      JSON.stringify(entry({ ts: daysAgo(2), message: 'b' }));
    const result = parseJsonl(input);
    expect(result).toHaveLength(2);
    // Newest first
    expect(result[0].message).toBe('a');
    expect(result[1].message).toBe('b');
  });

  test('skips malformed lines silently', () => {
    const input = JSON.stringify(entry({ message: 'good' })) + '\n{not json\n';
    const result = parseJsonl(input);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('good');
  });

  test('skips entries missing required fields', () => {
    const input = '{"foo":"bar"}\n' + JSON.stringify(entry({ message: 'good' }));
    const result = parseJsonl(input);
    expect(result).toHaveLength(1);
  });

  test('handles trailing newline', () => {
    const input = JSON.stringify(entry({ message: 'a' })) + '\n';
    expect(parseJsonl(input)).toHaveLength(1);
  });

  test('blank lines are ignored', () => {
    const input = '\n\n' + JSON.stringify(entry({ message: 'a' })) + '\n\n';
    expect(parseJsonl(input)).toHaveLength(1);
  });
});

describe('pruneOld', () => {
  test('keeps entries within 30 days', () => {
    const entries: LogEntry[] = [
      entry({ ts: daysAgo(1) }),
      entry({ ts: daysAgo(15) }),
      entry({ ts: daysAgo(29) }),
    ];
    expect(pruneOld(entries, NOW)).toHaveLength(3);
  });

  test('drops entries older than 30 days', () => {
    const entries: LogEntry[] = [
      entry({ ts: daysAgo(1), message: 'recent' }),
      entry({ ts: daysAgo(31), message: 'old' }),
    ];
    const result = pruneOld(entries, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('recent');
  });

  test('boundary: exactly 30 days kept (inclusive)', () => {
    const entries: LogEntry[] = [entry({ ts: daysAgo(30) })];
    expect(pruneOld(entries, NOW)).toHaveLength(1);
  });

  test('empty input returns empty', () => {
    expect(pruneOld([], NOW)).toEqual([]);
  });
});

describe('filterByWindow — day windows', () => {
  const all: LogEntry[] = [
    entry({ ts: daysAgo(1), message: '1d' }),
    entry({ ts: daysAgo(4), message: '4d' }),
    entry({ ts: daysAgo(10), message: '10d' }),
    entry({ ts: daysAgo(20), message: '20d' }),
    entry({ ts: daysAgo(28), message: '28d' }),
  ];

  test('3d window keeps only entries within 3 days', () => {
    const result = filterByWindow(all, '3d', NOW);
    expect(result.map((e) => e.message)).toEqual(['1d']);
  });

  test('7d window', () => {
    const result = filterByWindow(all, '7d', NOW);
    expect(result.map((e) => e.message)).toEqual(['1d', '4d']);
  });

  test('15d window', () => {
    const result = filterByWindow(all, '15d', NOW);
    expect(result.map((e) => e.message)).toEqual(['1d', '4d', '10d']);
  });

  test('30d window includes all', () => {
    expect(filterByWindow(all, '30d', NOW)).toHaveLength(5);
  });
});

describe('filterByWindow — last-run', () => {
  test('groups entries by runId, returns only newest run', () => {
    const entries: LogEntry[] = [
      entry({ ts: daysAgo(0), message: 'newest run start', runId: 'r2' }),
      entry({ ts: daysAgo(0), message: 'newest run end', runId: 'r2' }),
      entry({ ts: daysAgo(1), message: 'older run', runId: 'r1' }),
    ];
    const result = filterByWindow(entries, 'last-run', NOW);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.runId === 'r2')).toBe(true);
  });

  test('falls back to single newest entry when no runId on newest', () => {
    const entries: LogEntry[] = [
      entry({ ts: daysAgo(0), message: 'ad-hoc info' }),
      entry({ ts: daysAgo(1), message: 'old run', runId: 'r1' }),
    ];
    const result = filterByWindow(entries, 'last-run', NOW);
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe('ad-hoc info');
  });

  test('empty input returns empty', () => {
    expect(filterByWindow([], 'last-run', NOW)).toEqual([]);
  });
});