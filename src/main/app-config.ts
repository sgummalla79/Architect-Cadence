import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { normalizeLoginUrl } from './oauth';
import { JobConfig, ValidationResult, validateConfig } from '../shared';

const CONFIG_FILENAME = 'app-config.json';
const DEFAULT_LOGIN_URL = 'https://login.salesforce.com';

export function getAppConfigPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILENAME);
}

/** Derives the login URL from the config's domain field; falls back to login.salesforce.com. */
export function resolveLoginUrl(): string {
  const p = getAppConfigPath();
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

/** Loads and validates app-config.json; returns errors if missing or invalid. */
export function loadAppConfig(): ValidationResult {
  const p = getAppConfigPath();
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

/** Returns the raw JSON text of app-config.json, or empty string if missing. */
export function readAppConfigRaw(): string {
  const p = getAppConfigPath();
  if (!fs.existsSync(p)) return '';
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Validates and writes raw JSON to app-config.json; returns formatted text on success. */
export function saveAppConfigRaw(rawText: string): ValidationResult & { formatted?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    return { ok: false, errors: [`Not valid JSON: ${(err as Error).message}`] };
  }

  const validation = validateConfig(parsed);
  if (!validation.ok) return validation;

  const formatted = JSON.stringify(parsed, null, 2) + '\n';
  const p = getAppConfigPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, formatted, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Could not write config: ${(err as Error).message}`] };
  }
  return { ok: true, config: validation.config, formatted };
}

/** Overwrites app-config.json with the dev or prod config. */
export function writeConfigForEnv(env: 'dev' | 'prod'): void {
  const p = getAppConfigPath();
  const config = env === 'prod' ? PROD_CONFIG : DEV_CONFIG;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

// ============ Dev config ============

const DEV_CONFIG: JobConfig = {
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
    cardDisplay: {
      nameField:   'Name',
      titleField:  'Title__c',
      stageField:  'Stage__c',
      statusField: 'Engagement_Status__c',
    },
    customerCallAction: {
      updateFields: [
        { field: 'Engagement_Status__c', value: 'Call/Meeting Scheduled' },
      ],
      createRecords: [
        {
          object: 'Activity__c',
          fields: [
            { field: 'Name',           value: 'Customer Call' },
            { field: 'Priority__c',    value: 'High' },
            { field: 'Type__c',        value: 'External Meeting' },
            { field: 'Notes__c',       value: 'Please update notes on this record after customer call is completed' },
            { field: 'Engagement__c',  value: '{recordId}' },
            { field: 'AssignedTo__c',  soql: "SELECT Id FROM User WHERE Id = '{currentUserId}'", soqlResultField: 'Id' },
            { field: 'StartDate__c',   value: '{currentDate}' },
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
            { field: 'Name',           value: 'Internal Call with CSM/Product' },
            { field: 'Priority__c',    value: 'Medium' },
            { field: 'Type__c',        value: 'Internal Meeting' },
            { field: 'Notes__c',       value: 'Please update notes on this record after internal call is completed' },
            { field: 'Engagement__c',  value: '{recordId}' },
            { field: 'AssignedTo__c',  soql: "SELECT Id FROM User WHERE Id = '{currentUserId}'", soqlResultField: 'Id' },
            { field: 'StartDate__c',   value: '{currentDate}' },
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

// ============ Production config ============

const PROD_CONFIG: JobConfig = {
  domain: 'orgcs.my.salesforce.com',
  apiVersion: 'v66.0',
  logLevel: 'info',
  object: 'csc__Playbook__c',
  ownerFieldName: 'OwnerId',
  maxRecords: 15,
  dailySchedule: {
    filters: {
      conditions: [
        { field: 'csc__Stage__c', operator: '=', value: 'Delivery' },
        { field: 'csc__Playbook_Status__c', operator: '!=', value: 'Waiting on Customer' },
      ],
      logic: '1 AND 2',
    },
    updateFields: [{ field: 'csc__Playbook_Status__c', value: 'Waiting on Customer' }],
  },
  engagementsView: {
    query: {
      fields: ['Engagement_ID__c', 'Name', 'csc__Stage__c', 'csc__Playbook_Status__c'],
      conditions: [
        { field: 'csc__Stage__c', operator: '=', value: 'Delivery' },
      ],
      logic: '1',
    },
    callDurations: ['30s', '1m', '5m', '15m', '30m', '45m', '1h'],
    cardDisplay: {
      nameField:   'Engagement_ID__c',
      titleField:  'Name',
      stageField:  'csc__Stage__c',
      statusField: 'csc__Playbook_Status__c',
    },
    customerCallAction: {
      updateFields: [
        { field: 'csc__Playbook_Status__c', value: 'Call/Meeting Scheduled' },
      ],
      createRecords: [
        {
          object: 'csc__Activity__c',
          fields: [
            { field: 'cssf_Subject__c',     value: 'Customer Call' },
            { field: 'cssf_Priority__c',    value: 'High' },
            { field: 'csc__Type__c',        value: 'Customer Meeting' },
            { field: 'csc__Notes__c',       value: '<p>Customer Meeting - Update the notes here after meeting</p>' },
            { field: 'csc__Summary__c',       value: 'Customer Call' },
            { field: 'cssf_Engagement__c',  value: '{recordId}' },
            { field: 'cssf_Assigned_To__c', soql: "SELECT Id FROM csc__Resource__c WHERE csc__Salesforce_User__c = '{currentUserId}'", soqlResultField: 'Id' },
            { field: 'cssf_Start_Date__c',  value: '{currentDate}' },
          ],
        },
      ],
    },
    internalCallAction: {
      updateFields: [
        { field: 'csc__Playbook_Status__c', value: 'Call/Meeting Scheduled' },
      ],
      createRecords: [
        {
          object: 'csc__Activity__c',
          fields: [
            { field: 'cssf_Subject__c',     value: 'Internal Call with CSM/Product' },
            { field: 'cssf_Priority__c',    value: 'Medium' },
            { field: 'csc__Type__c',        value: 'Internal Meeting' },
            { field: 'csc__Notes__c',       value: '<p>Internal Meeting with CSM/Product - Update the notes here after meeting</p>' },
            { field: 'csc__Summary__c',       value: 'Internal Call with CSM/Product' },
            { field: 'cssf_Engagement__c',  value: '{recordId}' },
            { field: 'cssf_Assigned_To__c', soql: "SELECT Id FROM csc__Resource__c WHERE csc__Salesforce_User__c = '{currentUserId}'", soqlResultField: 'Id' },
            { field: 'cssf_Start_Date__c',  value: '{currentDate}' },
          ],
        },
      ],
    },
    workingAction: {
      updateFields: [
        { field: 'csc__Playbook_Status__c', value: 'In Progress' },
      ],
    },
    endCallAction: {
      updateFields: [
        { field: 'csc__Playbook_Status__c', value: 'Waiting on Customer' },
      ],
    },
  },
};
