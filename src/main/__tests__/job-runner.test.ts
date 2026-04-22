import { describe, test, expect, vi } from 'vitest';
import { runJob } from '../job-runner';
import { QueryRecord, SalesforceApiError, SalesforceClient } from '../salesforce-client';
import { JobConfig } from '../../shared';

function mockClient(overrides: Partial<SalesforceClient> = {}): SalesforceClient {
  return {
    query: vi.fn().mockResolvedValue({ totalSize: 0, done: true, records: [] }),
    updateRecords: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as SalesforceClient;
}

function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    domain: 'foo.my.salesforce.com',
    apiVersion: 'v66.0',
    object: 'Student__c',
    ownerFieldName: 'OwnerId',
    maxRecords: 15,
    dailySchedule: {
      filters: {
        conditions: [{ field: 'Final_Result__c', operator: '=', value: 'Withdrawn' }],
        logic: '1',
      },
      updateFields: [{ field: 'Final_Result__c', value: 'Distinction' }],
    },
    ...overrides,
  };
}

function makeRecords(count: number): QueryRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    Id: `a0${String(i).padStart(4, '0')}`,
    attributes: { type: 'Student__c' },
  }));
}

describe('runJob — happy path (Active)', () => {
  test('matches records, updates all, returns success', async () => {
    const records = makeRecords(3);
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 3, done: true, records }),
      updateRecords: vi.fn().mockResolvedValue([
        { id: 'a00000', success: true, errors: [] },
        { id: 'a00001', success: true, errors: [] },
        { id: 'a00002', success: true, errors: [] },
      ]),
    });

    const result = await runJob({
      config: makeConfig(),
      isActive: true,
      client,
      currentUserId: '005A0000001abcd',
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('update');
    expect(result.matchedCount).toBe(3);
    expect(result.updatedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.message).toBe('Updated 3 record(s).');
  });

  test('no matches returns ok with message', async () => {
    const client = mockClient();
    const result = await runJob({
      config: makeConfig(),
      isActive: true,
      client,
      currentUserId: '005A',
    });
    expect(result.ok).toBe(true);
    expect(result.matchedCount).toBe(0);
    expect(result.message).toMatch(/No records matched/);
    expect(client.updateRecords).not.toHaveBeenCalled();
  });
});

describe('runJob — guardrail', () => {
  test('exceeds maxRecords → update skipped, ok=false', async () => {
    // maxRecords=3 means LIMIT=4 in the SOQL. If the query returns 4 records,
    // that means >3 matched — guardrail trips.
    const records = makeRecords(4);
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 4, done: true, records }),
    });

    const result = await runJob({
      config: makeConfig({ maxRecords: 3 }),
      isActive: true,
      client,
      currentUserId: '005A',
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('guardrail');
    expect(result.message).toMatch(/Guardrail triggered/);
    expect(result.message).toMatch(/more than 3 records/);
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  test('exactly at maxRecords → proceeds with update', async () => {
    const records = makeRecords(3);
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 3, done: true, records }),
      updateRecords: vi.fn().mockResolvedValue(
        records.map((r) => ({ id: r.Id, success: true, errors: [] }))
      ),
    });

    const result = await runJob({
      config: makeConfig({ maxRecords: 3 }),
      isActive: true,
      client,
      currentUserId: '005A',
    });

    expect(result.ok).toBe(true);
    expect(result.mode).toBe('update');
    expect(client.updateRecords).toHaveBeenCalledOnce();
  });
});

describe('runJob — Inactive mode', () => {
  test('runs SELECT, logs matches, skips update, returns ok=false', async () => {
    const records = makeRecords(2);
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 2, done: true, records }),
    });

    const result = await runJob({
      config: makeConfig(),
      isActive: false,
      client,
      currentUserId: '005A',
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('select-only');
    expect(result.matchedCount).toBe(2);
    expect(result.recordIds).toEqual(['a00000', 'a00001']);
    expect(result.message).toMatch(/would be updated/);
    expect(result.message).toMatch(/app is Inactive/);
    expect(client.updateRecords).not.toHaveBeenCalled();
  });

  test('inactive + no matches still returns ok=true (nothing to skip)', async () => {
    const client = mockClient();
    const result = await runJob({
      config: makeConfig(),
      isActive: false,
      client,
      currentUserId: '005A',
    });
    expect(result.ok).toBe(true);
    expect(result.matchedCount).toBe(0);
  });
});

describe('runJob — partial failures', () => {
  test('some records fail → ok=false with counts', async () => {
    const records = makeRecords(3);
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 3, done: true, records }),
      updateRecords: vi.fn().mockResolvedValue([
        { id: 'a00000', success: true, errors: [] },
        { id: 'a00001', success: false, errors: [{ statusCode: 'FIELD_VALIDATION', message: 'Bad value' }] },
        { id: 'a00002', success: true, errors: [] },
      ]),
    });

    const result = await runJob({
      config: makeConfig(),
      isActive: true,
      client,
      currentUserId: '005A',
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('update');
    expect(result.updatedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.message).toMatch(/Updated 2\/3 records/);
    expect(result.message).toMatch(/FIELD_VALIDATION/);
  });
});

describe('runJob — errors', () => {
  test('SalesforceApiError from query is caught and wrapped', async () => {
    const client = mockClient({
      query: vi.fn().mockRejectedValue(
        new SalesforceApiError(400, 'INVALID_FIELD', "No such column 'Foo__c'")
      ),
    });

    const result = await runJob({
      config: makeConfig(),
      isActive: true,
      client,
      currentUserId: '005A',
    });

    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.message).toMatch(/INVALID_FIELD/);
    expect(result.message).toMatch(/No such column/);
  });

  test('generic errors are caught and message is scrubbed', async () => {
    const client = mockClient({
      query: vi.fn().mockRejectedValue(new Error('Request failed with Bearer 00D0000ABCDEFG_invalid_token')),
    });
    const result = await runJob({
      config: makeConfig(),
      isActive: true,
      client,
      currentUserId: '005A',
    });
    expect(result.ok).toBe(false);
    expect(result.mode).toBe('error');
    expect(result.message).toContain('Bearer ***');
    expect(result.message).not.toContain('00D0000ABCDEFG');
  });
});

describe('runJob — update payload shape', () => {
  test('update payload has Id + each updateField applied to every record', async () => {
    const records = makeRecords(2);
    let captured: Array<{ Id: string; [k: string]: unknown }> = [];
    const client = mockClient({
      query: vi.fn().mockResolvedValue({ totalSize: 2, done: true, records }),
      updateRecords: vi.fn().mockImplementation(async (_object, payload) => {
        captured = payload;
        return payload.map((r: any) => ({ id: r.Id, success: true, errors: [] }));
      }),
    });

    await runJob({
      config: makeConfig({
        dailySchedule: {
          filters: {
            conditions: [{ field: 'Final_Result__c', operator: '=', value: 'Withdrawn' }],
            logic: '1',
          },
          updateFields: [
            { field: 'Final_Result__c', value: 'Distinction' },
            { field: 'Notes__c', value: 'auto-updated' },
          ],
        },
      }),
      isActive: true,
      client,
      currentUserId: '005A',
    });

    expect(captured).toEqual([
      { Id: 'a00000', Final_Result__c: 'Distinction', Notes__c: 'auto-updated' },
      { Id: 'a00001', Final_Result__c: 'Distinction', Notes__c: 'auto-updated' },
    ]);
  });
});