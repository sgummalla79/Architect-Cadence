import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock electron BEFORE importing the module under test, since notifications.ts
// imports from 'electron' at module load.
vi.mock('electron', () => {
  const mockNotification = vi.fn();
  // Static method:
  (mockNotification as any).isSupported = vi.fn(() => true);
  return {
    Notification: mockNotification,
    BrowserWindow: vi.fn(),
  };
});

import { Notification } from 'electron';
import { notifyScheduledRun } from '../notifications';
import type { RunResult } from '../job-runner';

const NotificationMock = Notification as unknown as ReturnType<typeof vi.fn>;
const isSupportedMock = (NotificationMock as any).isSupported as ReturnType<typeof vi.fn>;

function makeShowAndOnSpies() {
  const show = vi.fn();
  const on = vi.fn();
  // mockImplementation must produce an object — but the function itself must
  // remain a regular vi.fn() (which is callable as `new`). When `new vi.fn()`
  // is called, the implementation runs and its return value becomes the
  // constructed object (since it returns a non-primitive). This works.
  NotificationMock.mockImplementation(function (this: any) {
    this.show = show;
    this.on = on;
    return this;
  });
  return { show, on };
}

function result(overrides: Partial<RunResult>): RunResult {
  return {
    ok: false,
    mode: 'error',
    matchedCount: 0,
    recordIds: [],
    message: 'Something went wrong',
    durationMs: 100,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  NotificationMock.mockReset();
  isSupportedMock.mockReset();
  isSupportedMock.mockReturnValue(true);
});

describe('notifyScheduledRun', () => {
  test('notifies on success', () => {
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: true, mode: 'update', message: '✓ Updated 3 record(s).' }),
      { getMainWindow: () => null }
    );
    expect(NotificationMock).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();
    const callArg = NotificationMock.mock.calls[0][0] as { title: string; body: string };
    expect(callArg.title).toBe('Architect Companion');
    expect(callArg.body).toMatch(/Updated 3/);
  });

  test('does NOT notify when inactive (select-only mode)', () => {
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'select-only', matchedCount: 5, message: 'Found 5 records that would be updated' }),
      { getMainWindow: () => null }
    );
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  test('notifies on guardrail trigger', () => {
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'guardrail', matchedCount: 23, message: 'Guardrail triggered: query returned more than 15 records' }),
      { getMainWindow: () => null }
    );
    expect(NotificationMock).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledOnce();

    const callArg = NotificationMock.mock.calls[0][0] as { title: string; body: string };
    expect(callArg.title).toBe('Architect Companion');
    expect(callArg.body).toMatch(/Guardrail triggered/);
  });

  test('notifies on partial failure (mode=update but ok=false)', () => {
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'update', matchedCount: 5, updatedCount: 3, failedCount: 2, message: 'Updated 3/5 records; 2 failed.' }),
      { getMainWindow: () => null }
    );
    expect(show).toHaveBeenCalledOnce();
  });

  test('notifies on API/auth error', () => {
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'error', message: 'Salesforce API error [INVALID_SESSION]: Session expired' }),
      { getMainWindow: () => null }
    );
    expect(show).toHaveBeenCalledOnce();
    const callArg = NotificationMock.mock.calls[0][0] as { title: string; body: string };
    expect(callArg.body).toMatch(/INVALID_SESSION/);
  });

  test('skips silently when Notification.isSupported() is false', () => {
    isSupportedMock.mockReturnValue(false);
    const { show } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'error', message: 'Something failed' }),
      { getMainWindow: () => null }
    );
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  test('attaches click handler that focuses main window', () => {
    const { on } = makeShowAndOnSpies();

    const focus = vi.fn();
    const restore = vi.fn();
    const showWin = vi.fn();
    const isMinimized = vi.fn(() => false);
    const fakeWin = { focus, restore, show: showWin, isMinimized } as any;

    notifyScheduledRun(
      result({ ok: false, mode: 'error', message: 'Failed' }),
      { getMainWindow: () => fakeWin }
    );

    expect(on).toHaveBeenCalledWith('click', expect.any(Function));

    // Trigger the registered click handler.
    const clickHandler = on.mock.calls[0][1] as () => void;
    clickHandler();

    expect(showWin).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled(); // not minimized → no restore needed
  });

  test('click handler restores window when minimized', () => {
    const { on } = makeShowAndOnSpies();

    const focus = vi.fn();
    const restore = vi.fn();
    const showWin = vi.fn();
    const isMinimized = vi.fn(() => true);
    const fakeWin = { focus, restore, show: showWin, isMinimized } as any;

    notifyScheduledRun(
      result({ ok: false, mode: 'error', message: 'Failed' }),
      { getMainWindow: () => fakeWin }
    );

    const clickHandler = on.mock.calls[0][1] as () => void;
    clickHandler();

    expect(restore).toHaveBeenCalledOnce();
    expect(showWin).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
  });

  test('click handler is a no-op when window is null', () => {
    const { on } = makeShowAndOnSpies();
    notifyScheduledRun(
      result({ ok: false, mode: 'error', message: 'Failed' }),
      { getMainWindow: () => null }
    );
    const clickHandler = on.mock.calls[0][1] as () => void;
    expect(() => clickHandler()).not.toThrow();
  });
});