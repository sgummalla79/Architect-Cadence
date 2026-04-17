// Job runner.
// Combines the SOQL builder (Module 2), auth session (Module 3), and Salesforce
// client (this module) into a single end-to-end operation.
//
// The runner is UI-agnostic: it returns a structured RunResult that the caller
// (main process IPC handler or scheduler) decides how to log/display.

import { buildSoql, JobConfig } from '../shared';
import { QueryRecord, SalesforceApiError, SalesforceClient, scrubTokens } from './salesforce-client';

// ============ Result types ============

export type RunMode = 'update' | 'select-only' | 'guardrail' | 'error';

export interface RunResult {
  ok: boolean;
  mode: RunMode;
  /** How many records matched the SOQL (before guardrail check). */
  matchedCount: number;
  /** How many records were actually updated. Only populated when mode='update'. */
  updatedCount?: number;
  /** How many records failed during the update. */
  failedCount?: number;
  /** The Ids of records that matched (useful for logging in select-only mode). */
  recordIds: string[];
  /** Human-readable summary for display. */
  message: string;
  /** Millisecond duration of the full run. */
  durationMs: number;
  /** Timestamp the run started. */
  startedAt: string;
}

// ============ Runner ============

export interface RunParams {
  config: JobConfig;
  /** True if the schedule toggle is on. False means we run SELECT only + log "skipped". */
  isActive: boolean;
  /** Pre-built Salesforce client (bound to the current session). */
  client: SalesforceClient;
  /** Authenticated user Id for the owner filter. */
  currentUserId: string;
}

export async function runJob(params: RunParams): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const start = Date.now();

  try {
    // Step 1: Build SOQL with owner filter + guardrail LIMIT (maxRecords + 1).
    const { soql } = buildSoql(params.config, { currentUserId: params.currentUserId });

    // Step 2: Execute SELECT.
    const queryResult = await params.client.query<QueryRecord>(soql);
    const matched = queryResult.records;
    const recordIds = matched.map((r) => r.Id);

    // Step 3: Guardrail — our LIMIT was maxRecords + 1. If we got more than
    // maxRecords back, the real match count exceeded the ceiling.
    if (matched.length > params.config.maxRecords) {
      return finalize({
        ok: false,
        mode: 'guardrail',
        matchedCount: matched.length,
        recordIds,
        message:
          `Guardrail triggered: query returned more than ${params.config.maxRecords} records ` +
          `(max allowed). Update skipped.`,
      });
    }

    // Step 4: If there's nothing to update, short-circuit.
    if (matched.length === 0) {
      return finalize({
        ok: true,
        mode: params.isActive ? 'update' : 'select-only',
        matchedCount: 0,
        updatedCount: 0,
        recordIds: [],
        message: 'No records matched the filter. Nothing to update.',
      });
    }

    // Step 5: If inactive, log the IDs we would have updated and skip the UPDATE.
    if (!params.isActive) {
      return finalize({
        ok: false,
        mode: 'select-only',
        matchedCount: matched.length,
        recordIds,
        message:
          `Found ${matched.length} record(s) that would be updated (${recordIds.join(', ')}). ` +
          `Update not executed because the app is Inactive.`,
      });
    }

    // Step 6: Build the update payload and call sObject Collections.
    const updatePayload = buildUpdatePayload(matched, params.config);
    const outcomes = await params.client.updateRecords(params.config.object, updatePayload);

    const updated = outcomes.filter((o) => o.success).length;
    const failed = outcomes.length - updated;

    if (failed > 0) {
      // Partial success — log but mark as failed overall so user gets a notification.
      const firstErr = outcomes.find((o) => !o.success);
      const errDetail = firstErr?.errors?.[0]
        ? ` First error: [${firstErr.errors[0].statusCode}] ${firstErr.errors[0].message}`
        : '';
      return finalize({
        ok: false,
        mode: 'update',
        matchedCount: matched.length,
        updatedCount: updated,
        failedCount: failed,
        recordIds,
        message: `Updated ${updated}/${matched.length} records; ${failed} failed.${errDetail}`,
      });
    }

    return finalize({
      ok: true,
      mode: 'update',
      matchedCount: matched.length,
      updatedCount: updated,
      failedCount: 0,
      recordIds,
      message: `Updated ${updated} record(s).`,
    });
  } catch (err) {
    let message: string;
    if (err instanceof SalesforceApiError) {
      message = `Salesforce API error [${err.errorCode}]: ${err.message}`;
    } else {
      message = scrubTokens((err as Error).message ?? 'Unknown error');
    }
    return finalize({
      ok: false,
      mode: 'error',
      matchedCount: 0,
      recordIds: [],
      message,
    });
  }

  // Always attach started timestamp + duration.
  function finalize(partial: Omit<RunResult, 'durationMs' | 'startedAt'>): RunResult {
    return { ...partial, durationMs: Date.now() - start, startedAt };
  }
}

// ============ Payload building ============

function buildUpdatePayload(
  records: QueryRecord[],
  config: JobConfig
): Array<{ Id: string; [field: string]: unknown }> {
  const updates: Record<string, unknown> = {};
  for (const u of config.updateFields) {
    updates[u.field] = u.value;
  }
  return records.map((r) => ({ Id: r.Id, ...updates }));
}