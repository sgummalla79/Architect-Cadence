// Scheduler — wraps node-cron with start/stop/reschedule semantics.
// Serializes runs so two scheduled invocations (or schedule + Run Now) don't
// race with each other.

import * as cron from 'node-cron';

/** Convert an HH:MM (or HH:MM:SS) 24h time string into a cron expression (`M H * * *`). */
export function timeToCron(hhmm: string): string {
  // Some <input type="time"> implementations include seconds. We accept both.
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(hhmm);
  if (!m) {
    throw new Error(`Invalid time '${hhmm}'. Expected HH:MM (24-hour).`);
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  return `${minute} ${hour} * * *`;
}

export interface SchedulerOptions {
  /** Initial scheduled time, "HH:MM". */
  scheduledTime: string;
  /** If false, scheduler is created but not running. */
  active: boolean;
  /** Called each time the schedule fires. Returned promise serializes back-to-back fires. */
  onTick: () => Promise<void>;
}

export interface Scheduler {
  /** Update both active state + time. Tears down + rebuilds cron job as needed. */
  reconfigure(opts: { scheduledTime: string; active: boolean }): void;
  /** Stop the cron task and free resources. */
  stop(): void;
  /** Diagnostic: the cron expression currently installed, or null if paused. */
  currentExpression(): string | null;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  let task: cron.ScheduledTask | null = null;
  let currentExpr: string | null = null;
  let isRunning = false; // true while onTick is in progress; serializes fires.

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const tick = async (): Promise<void> => {
    console.log(`[scheduler] Tick at ${new Date().toISOString()} (tz=${tz})`);
    if (isRunning) {
      console.log('[scheduler] Previous tick still running — skipping this fire');
      return;
    }
    isRunning = true;
    try {
      await options.onTick();
    } catch (err) {
      console.error(`[scheduler] onTick threw: ${(err as Error).message}`);
    } finally {
      isRunning = false;
    }
  };

  const buildTask = (time: string): cron.ScheduledTask => {
    const expr = timeToCron(time);
    // Pass explicit timezone so we don't depend on node-cron's default behavior.
    const t = cron.schedule(
      expr,
      () => { void tick(); },
      { timezone: tz }
    );
    currentExpr = expr;
    console.log(`[scheduler] Installed cron '${expr}' (tz=${tz}) for time '${time}'`);
    return t;
  };

  // Initial setup
  if (options.active) {
    task = buildTask(options.scheduledTime);
  } else {
    console.log('[scheduler] Created in paused state (isActive=false)');
  }

  return {
    reconfigure({ scheduledTime, active }) {
      console.log(`[scheduler] Reconfigure: time=${scheduledTime}, active=${active}`);
      if (task) {
        task.stop();
        task = null;
        currentExpr = null;
      }
      if (active) {
        task = buildTask(scheduledTime);
      } else {
        console.log('[scheduler] Now paused');
      }
    },
    stop() {
      if (task) {
        task.stop();
        task = null;
        currentExpr = null;
      }
    },
    currentExpression() {
      return currentExpr;
    },
  };
}