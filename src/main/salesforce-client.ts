// Minimal Salesforce REST client using native fetch.
//
// Intentionally small surface: we only need SELECT and batch UPDATE.
// Handles:
//   - Authorization via bearer token
//   - Automatic refresh + retry on 401 (calls the session's forceRefresh)
//   - Structured errors (status code + Salesforce error code)
//   - Token masking in any error message that might bubble up to the UI
//
// We do NOT log response bodies — they can contain PII and sometimes tokens.
// Only error codes + descriptions are surfaced.

export class SalesforceApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'SalesforceApiError';
  }
}

/** A single record from a SOQL query. The shape depends on the SELECT fields. */
export type QueryRecord = Record<string, unknown> & { Id: string; attributes?: unknown };

export interface QueryResult<T extends QueryRecord = QueryRecord> {
  totalSize: number;
  done: boolean;
  records: T[];
  nextRecordsUrl?: string;
}

export interface UpdateOutcome {
  id: string;
  success: boolean;
  errors: Array<{ statusCode: string; message: string; fields?: string[] }>;
}

export interface SalesforceClient {
  /** Execute a SOQL query. */
  query<T extends QueryRecord = QueryRecord>(soql: string): Promise<QueryResult<T>>;

  /**
   * Update up to 200 records in one call. Each input must contain `Id`.
   * Returns per-record outcomes (Salesforce sObject Collections semantics).
   */
  updateRecords(
    object: string,
    records: Array<{ Id: string; [field: string]: unknown }>
  ): Promise<UpdateOutcome[]>;
}

export interface CreateClientOptions {
  instanceUrl: string;
  /** e.g. 'v66.0'. */
  apiVersion: string;
  /** Returns the current access token (cached, refreshes as needed). */
  getAccessToken: () => Promise<string>;
  /** Force a refresh and return the new token. Called on 401 retry. */
  forceRefresh: () => Promise<string>;
}

// ============ Factory ============

export function createSalesforceClient(options: CreateClientOptions): SalesforceClient {
  const baseUrl = `${trimSlash(options.instanceUrl)}/services/data/${options.apiVersion}`;

  async function doFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `${baseUrl}${path}`;
    const makeRequest = async (token: string): Promise<Response> => {
      return fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    };

    let token = await options.getAccessToken();
    let response = await makeRequest(token);

    // 401 → refresh once and retry. More than one retry indicates a deeper problem.
    if (response.status === 401) {
      token = await options.forceRefresh();
      response = await makeRequest(token);
    }

    return response;
  }

  return {
    async query<T extends QueryRecord>(soql: string): Promise<QueryResult<T>> {
      const response = await doFetch('GET', `/query?q=${encodeURIComponent(soql)}`);
      if (!response.ok) {
        throw await parseApiError(response);
      }
      return (await response.json()) as QueryResult<T>;
    },

    async updateRecords(object, records): Promise<UpdateOutcome[]> {
      if (records.length === 0) return [];
      if (records.length > 200) {
        throw new Error(
          `sObject Collections accepts at most 200 records per call (got ${records.length}).`
        );
      }

      // Salesforce expects each record to have attributes.type = object name.
      const payload = {
        allOrNone: false,
        records: records.map((r) => ({
          attributes: { type: object },
          ...r,
        })),
      };

      const response = await doFetch('PATCH', '/composite/sobjects', payload);
      if (!response.ok) {
        throw await parseApiError(response);
      }
      return (await response.json()) as UpdateOutcome[];
    },
  };
}

// ============ Error handling ============

async function parseApiError(response: Response): Promise<SalesforceApiError> {
  let errorCode = 'UNKNOWN';
  let message = `HTTP ${response.status}`;

  try {
    const body = await response.json();
    // Salesforce errors are typically: [{ errorCode: 'X', message: 'Y' }]
    if (Array.isArray(body) && body.length > 0 && body[0]) {
      const first = body[0] as { errorCode?: string; message?: string };
      errorCode = first.errorCode ?? errorCode;
      message = first.message ?? message;
    } else if (body && typeof body === 'object') {
      const obj = body as { error?: string; error_description?: string; message?: string };
      errorCode = obj.error ?? errorCode;
      message = obj.error_description ?? obj.message ?? message;
    }
  } catch {
    // Non-JSON body — fall back to status text.
    message = response.statusText || message;
  }

  // Defense-in-depth: scrub anything that looks like a bearer token before
  // letting the error message propagate to logs or the UI.
  return new SalesforceApiError(response.status, errorCode, scrubTokens(message));
}

/** Mask anything that looks like a Salesforce bearer token in a string. */
export function scrubTokens(input: string): string {
  // Salesforce access tokens are typically long base64-ish strings, often starting with
  // '00D' (org id prefix) or appearing after 'Bearer '. We scrub broadly to be safe.
  return input
    .replace(/Bearer\s+[A-Za-z0-9!._-]+/g, 'Bearer ***')
    .replace(/access_token["']?\s*[:=]\s*["']?[A-Za-z0-9!._-]{20,}/gi, 'access_token=***')
    .replace(/refresh_token["']?\s*[:=]\s*["']?[A-Za-z0-9!._-]{20,}/gi, 'refresh_token=***');
}

/** Mask a token for log output, preserving enough for correlation but not enough to reuse. */
export function maskToken(token: string): string {
  if (!token || token.length < 12) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

// ============ Helpers ============

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}