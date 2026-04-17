import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createSalesforceClient, maskToken, scrubTokens, SalesforceApiError } from '../salesforce-client';

describe('scrubTokens', () => {
  test('masks Bearer header', () => {
    expect(scrubTokens('Failed: Bearer 00D1234567890abcdef!ABC123'))
      .toBe('Failed: Bearer ***');
  });

  test('masks access_token key=value', () => {
    const input = 'error: access_token=00D1234567890abcdef!ABC';
    expect(scrubTokens(input)).toContain('access_token=***');
  });

  test('masks refresh_token in JSON-ish strings', () => {
    const input = '{"refresh_token":"5Aep123456789012345ABCDEFGHI"}';
    expect(scrubTokens(input)).toContain('refresh_token=***');
  });

  test('leaves non-token text untouched', () => {
    expect(scrubTokens('No such field Final_Result__c')).toBe('No such field Final_Result__c');
  });
});

describe('maskToken', () => {
  test('masks to prefix…suffix format', () => {
    expect(maskToken('abcdefghijklmnopqrst')).toBe('abcdef…qrst');
  });
  test('returns *** for short tokens', () => {
    expect(maskToken('short')).toBe('***');
    expect(maskToken('')).toBe('***');
  });
});

describe('SalesforceApiError', () => {
  test('captures status + errorCode', () => {
    const err = new SalesforceApiError(400, 'INVALID_FIELD', 'No such column');
    expect(err.statusCode).toBe(400);
    expect(err.errorCode).toBe('INVALID_FIELD');
    expect(err.message).toBe('No such column');
    expect(err.name).toBe('SalesforceApiError');
  });
});

describe('createSalesforceClient — query', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('sends GET with bearer token to /query', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ totalSize: 0, done: true, records: [] }), { status: 200 })
    );

    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'TOKEN_A',
      forceRefresh: async () => 'TOKEN_B',
    });

    await client.query('SELECT Id FROM Account');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://foo.my.salesforce.com/services/data/v66.0/query?q=SELECT%20Id%20FROM%20Account'
    );
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer TOKEN_A');
  });

  test('on 401, refreshes and retries once with new token', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('{"error":"expired"}', { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ totalSize: 1, done: true, records: [{ Id: 'a01', attributes: {} }] }), {
          status: 200,
        })
      );

    let forceRefreshCalls = 0;
    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'TOKEN_A',
      forceRefresh: async () => { forceRefreshCalls++; return 'TOKEN_B'; },
    });

    const result = await client.query('SELECT Id FROM Account');

    expect(forceRefreshCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Second request should use the refreshed token.
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer TOKEN_B');
    expect(result.records).toHaveLength(1);
  });

  test('throws SalesforceApiError on non-ok response', async () => {
    // Use a factory so each call gets a fresh Response (bodies can only be read once).
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify([{ errorCode: 'INVALID_FIELD', message: 'No such column' }]), {
          status: 400,
        })
    );

    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'X',
      forceRefresh: async () => 'Y',
    });

    await expect(client.query('bad soql')).rejects.toThrow(SalesforceApiError);
    await expect(client.query('bad soql')).rejects.toMatchObject({
      statusCode: 400,
      errorCode: 'INVALID_FIELD',
      message: 'No such column',
    });
  });
});

describe('createSalesforceClient — updateRecords', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('PATCHes composite/sobjects with the right payload shape', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'a01', success: true, errors: [] },
          { id: 'a02', success: true, errors: [] },
        ]),
        { status: 200 }
      )
    );

    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'T',
      forceRefresh: async () => 'T2',
    });

    await client.updateRecords('Student__c', [
      { Id: 'a01', Final_Result__c: 'Distinction' },
      { Id: 'a02', Final_Result__c: 'Distinction' },
    ]);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://foo.my.salesforce.com/services/data/v66.0/composite/sobjects');
    expect(opts.method).toBe('PATCH');
    expect(opts.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(opts.body);
    expect(body.allOrNone).toBe(false);
    expect(body.records).toHaveLength(2);
    expect(body.records[0]).toEqual({
      attributes: { type: 'Student__c' },
      Id: 'a01',
      Final_Result__c: 'Distinction',
    });
  });

  test('returns outcomes from response', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: 'a01', success: true, errors: [] },
          { id: 'a02', success: false, errors: [{ statusCode: 'INVALID', message: 'Nope' }] },
        ]),
        { status: 200 }
      )
    );

    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'T',
      forceRefresh: async () => 'T2',
    });

    const outcomes = await client.updateRecords('Student__c', [
      { Id: 'a01', F__c: 'x' },
      { Id: 'a02', F__c: 'x' },
    ]);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[1].success).toBe(false);
  });

  test('empty input returns empty array without calling fetch', async () => {
    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'T',
      forceRefresh: async () => 'T2',
    });
    const outcomes = await client.updateRecords('X__c', []);
    expect(outcomes).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects batch larger than 200', async () => {
    const client = createSalesforceClient({
      instanceUrl: 'https://foo.my.salesforce.com',
      apiVersion: 'v66.0',
      getAccessToken: async () => 'T',
      forceRefresh: async () => 'T2',
    });
    const big = Array.from({ length: 201 }, (_, i) => ({ Id: `a${i}`, F__c: 'x' }));
    await expect(client.updateRecords('X__c', big)).rejects.toThrow(/at most 200/);
  });
});