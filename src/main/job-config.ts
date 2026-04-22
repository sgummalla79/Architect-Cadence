// Reads the full job config from <userData>/job-config.json.
// On first run, scaffolds a sample config matching the spec example so the
// user can edit it via the Settings tab's "Edit Config" button without having
// to construct the file manually.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeLoginUrl } from './oauth';
import { JobConfig, ValidationResult, validateConfig } from '../shared';

const CONFIG_FILENAME = 'job-config.json';
const DEFAULT_LOGIN_URL = 'https://login.salesforce.com';

export function getJobConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/**
 * Return the login URL derived from the job config's `domain` field.
 * Falls back to https://login.salesforce.com if the file doesn't exist or the
 * domain isn't set. Does NOT fail on an invalid config — signing in should
 * still be possible even if the rest of the config needs fixing.
 */
export function resolveLoginUrl(): string {
  const p = getJobConfigPath();
  if (!fs.existsSync(p)) return DEFAULT_LOGIN_URL;
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as { domain?: unknown };
    if (typeof obj.domain === 'string' && obj.domain.trim().length > 0) {
      return normalizeLoginUrl(obj.domain);
    }
  } catch {
    // ignore
  }
  return DEFAULT_LOGIN_URL;
}

/** Load and validate the full job config. Returns a ValidationResult. */
export function loadJobConfig(): ValidationResult {
  const p = getJobConfigPath();
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      errors: [
        `Config file not found at ${p}. Click "Edit Config" in Settings to create it.`,
      ],
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Could not read config: ${(err as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`Config is not valid JSON: ${(err as Error).message}`] };
  }

  const { migrated, config: migratedConfig } = migrateConfig(parsed);
  if (migrated) {
    // Write the migrated config back so the file stays in sync with the current schema.
    try {
      fs.writeFileSync(p, JSON.stringify(migratedConfig, null, 2) + '\n', 'utf8');
      console.log('[config] Migrated job-config.json to current schema.');
    } catch (err) {
      console.warn('[config] Migration write failed:', (err as Error).message);
    }
    parsed = migratedConfig;
  }

  return validateConfig(parsed);
}

/**
 * Migrate a raw parsed config object from any previous schema version to the
 * current one. Returns the (possibly transformed) object and a flag indicating
 * whether a migration was applied so the caller can persist the change.
 *
 * Add a new `if` block here for every future schema change.
 */
function migrateConfig(raw: unknown): { migrated: boolean; config: unknown } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { migrated: false, config: raw };
  }

  let migrated = false;
  const obj = raw as Record<string, unknown>;

  // v1 → v2: top-level `filters` and `updateFields` moved under `dailySchedule`.
  if (('filters' in obj || 'updateFields' in obj) && !('dailySchedule' in obj)) {
    const { filters, updateFields, ...rest } = obj;
    obj['dailySchedule'] = { filters, updateFields };
    delete obj['filters'];
    delete obj['updateFields'];
    Object.assign(obj, rest);
    migrated = true;
  }

  // v2 → v3: add engagementsView with sample defaults if missing.
  if (!('engagementsView' in obj)) {
    obj['engagementsView'] = SAMPLE_CONFIG.engagementsView;
    migrated = true;
  }

  // v3 → v4: add call action configs if missing (old top-level placement).
  if (!('customerCallAction' in obj)) {
    obj['customerCallAction'] = SAMPLE_CONFIG.engagementsView!.customerCallAction;
    migrated = true;
  }
  if (!('internalCallAction' in obj)) {
    obj['internalCallAction'] = SAMPLE_CONFIG.engagementsView!.internalCallAction;
    migrated = true;
  }
  if (!('endCallAction' in obj)) {
    obj['endCallAction'] = SAMPLE_CONFIG.engagementsView!.endCallAction;
    migrated = true;
  }
  if (!('workingAction' in obj)) {
    obj['workingAction'] = SAMPLE_CONFIG.engagementsView!.workingAction;
    migrated = true;
  }

  // v4 → v5: move top-level action configs into engagementsView.
  if (
    'customerCallAction' in obj ||
    'internalCallAction' in obj ||
    'endCallAction' in obj ||
    'workingAction' in obj
  ) {
    const rawEv = obj['engagementsView'];
    const ev = (typeof rawEv === 'object' && rawEv !== null && !Array.isArray(rawEv) ? rawEv : {}) as Record<string, unknown>;
    if ('customerCallAction' in obj && !('customerCallAction' in ev)) ev['customerCallAction'] = obj['customerCallAction'];
    if ('internalCallAction' in obj && !('internalCallAction' in ev)) ev['internalCallAction'] = obj['internalCallAction'];
    if ('endCallAction' in obj && !('endCallAction' in ev)) ev['endCallAction'] = obj['endCallAction'];
    if ('workingAction' in obj && !('workingAction' in ev)) ev['workingAction'] = obj['workingAction'];
    obj['engagementsView'] = ev;
    delete obj['customerCallAction'];
    delete obj['internalCallAction'];
    delete obj['endCallAction'];
    delete obj['workingAction'];
    migrated = true;
  }

  // v5 → v6: add callDurations inside engagementsView if missing.
  {
    const rawEv = obj['engagementsView'];
    if (typeof rawEv === 'object' && rawEv !== null && !Array.isArray(rawEv)) {
      const ev = rawEv as Record<string, unknown>;
      if (!('callDurations' in ev)) {
        ev['callDurations'] = SAMPLE_CONFIG.engagementsView!.callDurations;
        migrated = true;
      }
    }
  }

  return { migrated, config: obj };
}

/** Read the raw JSON text of the config file. Returns empty string if missing. */
export function readJobConfigRaw(): string {
  const p = getJobConfigPath();
  if (!fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Validate then write the given raw JSON to the config file. Auto-formats
 * with 2-space indentation. Returns the formatted text on success, or a
 * ValidationResult with errors otherwise.
 */
export function saveJobConfigRaw(rawText: string): ValidationResult & { formatted?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }

  const validation = validateConfig(parsed);
  if (!validation.ok) return validation;

  const formatted = JSON.stringify(parsed, null, 2) + '\n';
  const p = getJobConfigPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, formatted, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Could not write config: ${(err as Error).message}`] };
  }
  return { ok: true, config: validation.config, formatted };
}

/**
 * Scaffold a sample config at <userData>/job-config.json if one doesn't exist.
 * Called on first app launch. Returns true if a file was written.
 */
export function scaffoldSampleConfigIfMissing(): boolean {
  const p = getJobConfigPath();
  if (fs.existsSync(p)) return false;
  writeSampleConfig();
  return true;
}

function writeSampleConfig(): void {
  const p = getJobConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(SAMPLE_CONFIG, null, 2) + '\n', 'utf8');
}

// ============ Sample config ============
// Matches the spec example. Users should edit this to match their real setup.

const SAMPLE_CONFIG: JobConfig = {
  domain: 'exp-cloud.my.salesforce.com',
  apiVersion: 'v66.0',
  logLevel: 'info',
  object: 'Engagement__c',
  ownerFieldName: 'OwnerId',
  maxRecords: 15,
  dailySchedule: {
    filters: {
      conditions: [
        { field: 'Stage__c', operator: '=', value: 'Delivery' },
        { field: 'Engagement_Status__c', operator: '!=', value: 'Waiting on Customer' },
      ],
      logic: '1 AND 2',
    },
    updateFields: [{ field: 'Engagement_Status__c', value: 'Waiting on Customer' }],
  },
  engagementsView: {
    query: {
      fields: ['Name', 'Title__c', 'Stage__c', 'Engagement_Status__c'],
      conditions: [
        { field: 'Stage__c', operator: '=', value: 'Delivery' },
      ],
      logic: '1',
    },
    callDurations: ['30s', '1m', '5m', '15m', '30m', '45m', '1h'],
    customerCallAction: {
      updateFields: [
        { field: 'Engagement_Status__c', value: 'Call/Meeting Scheduled' },
      ],
      createRecords: [
        {
          object: 'Activity__c',
          fields: [
            { field: 'Name',          value: 'Customer Call' },
            { field: 'Priority__c',   value: 'High' },
            { field: 'Type__c',       value: 'External Meeting' },
            { field: 'Notes__c',      value: 'Please update notes on this record after customer call is completed' },
            { field: 'Engagement__c', value: '{recordId}' },
          ],
        },
      ],
    },
    internalCallAction: {
      updateFields: [
        { field: 'Engagement_Status__c', value: 'Call/Meeting Scheduled' },
      ],
      createRecords: [
        {
          object: 'Activity__c',
          fields: [
            { field: 'Name',          value: 'Internal Call with CSM/Product' },
            { field: 'Priority__c',   value: 'Medium' },
            { field: 'Type__c',       value: 'Internal Meeting' },
            { field: 'Notes__c',      value: 'Please update notes on this record after internal call is completed' },
            { field: 'Engagement__c', value: '{recordId}' },
          ],
        },
      ],
    },
    workingAction: {
      updateFields: [
        { field: 'Engagement_Status__c', value: 'In Progress' },
      ],
    },
    endCallAction: {
      updateFields: [
        { field: 'Engagement_Status__c', value: 'Waiting on Customer' },
      ],
    },
  },
};