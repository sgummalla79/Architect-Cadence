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

  return validateConfig(parsed);
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
  domain: 'your-org.my.salesforce.com',
  apiVersion: 'v66.0',
  logLevel: 'info',
  object: 'Student__c',
  filters: {
    conditions: [
      { field: 'Final_Result__c', operator: '=', value: 'Withdrawn' },
      {
        field: 'Id',
        operator: 'IN',
        value: ['a0uKd00000L6xfQIAR', 'a0uKd00000L6xfRIAR'],
      },
    ],
    logic: '1 AND 2',
  },
  ownerFieldName: 'OwnerId',
  updateFields: [{ field: 'Final_Result__c', value: 'Distinction' }],
  maxRecords: 15,
};