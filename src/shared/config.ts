// Config loader + validator.
// Reads a JSON file from disk and validates it against the JobConfig shape.
// Returns structured errors rather than throwing, so the UI can display them clearly.

import * as fs from 'fs';
import {
  Condition,
  JobConfig,
  Operator,
  SUPPORTED_OPERATORS,
  ValidationResult,
} from './types';
import { parseLogic, collectIndices, LogicParseError } from './logic-parser';

// ============ Public API ============

/**
 * Load and validate a JSON config file from disk.
 * Returns a ValidationResult — either a successfully parsed config or a list of errors.
 */
export function loadConfig(path: string): ValidationResult {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (err) {
    return { ok: false, errors: [`Could not read config file: ${(err as Error).message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`Config is not valid JSON: ${(err as Error).message}`] };
  }

  return validateConfig(parsed);
}

/**
 * Validate an already-parsed object against the JobConfig schema.
 * Useful when the config is provided inline (e.g. tests, or the "Validate" UI button
 * passing in the current file contents).
 */
export function validateConfig(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(input)) {
    return { ok: false, errors: ['Config must be a JSON object.'] };
  }

  // Required top-level fields
  const domain = requireString(input, 'domain', errors);
  const apiVersion = requireString(input, 'apiVersion', errors);
  const object = requireString(input, 'object', errors);
  const ownerFieldName = requireString(input, 'ownerFieldName', errors);

  // maxRecords must be a positive integer
  const maxRecords = requirePositiveInt(input, 'maxRecords', errors);

  // apiVersion format check (vNN.N)
  if (apiVersion && !/^v\d+\.\d+$/.test(apiVersion)) {
    errors.push(`'apiVersion' should look like 'v66.0' — got '${apiVersion}'.`);
  }

  // logLevel (optional)
  if ('logLevel' in input) {
    const lv = (input as Record<string, unknown>).logLevel;
    if (lv !== 'debug' && lv !== 'info' && lv !== 'warn' && lv !== 'error') {
      errors.push(
        `'logLevel' must be one of: debug, info, warn, error. Got '${String(lv)}'.`
      );
    }
  }

  // filters
  const filters = validateFilters((input as Record<string, unknown>).filters, errors);

  // updateFields
  const updateFields = validateUpdateFields(
    (input as Record<string, unknown>).updateFields,
    errors
  );

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // All validations passed — build the typed config.
  const config: JobConfig = {
    domain: domain!,
    apiVersion: apiVersion!,
    object: object!,
    ownerFieldName: ownerFieldName!,
    maxRecords: maxRecords!,
    filters: filters!,
    updateFields: updateFields!,
  };
  if ('logLevel' in input) {
    config.logLevel = (input as { logLevel: JobConfig['logLevel'] }).logLevel;
  }
  return { ok: true, config };
}

// ============ Sub-validators ============

function validateFilters(
  input: unknown,
  errors: string[]
): JobConfig['filters'] | null {
  if (!isObject(input)) {
    errors.push(`'filters' is required and must be an object.`);
    return null;
  }

  const conditionsRaw = (input as Record<string, unknown>).conditions;
  const logicRaw = (input as Record<string, unknown>).logic;

  if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) {
    errors.push(`'filters.conditions' must be a non-empty array.`);
  }

  if (typeof logicRaw !== 'string' || logicRaw.trim().length === 0) {
    errors.push(`'filters.logic' must be a non-empty string.`);
  }

  const conditions: Condition[] = [];
  if (Array.isArray(conditionsRaw)) {
    conditionsRaw.forEach((c, i) => {
      const parsed = validateCondition(c, i, errors);
      if (parsed) conditions.push(parsed);
    });
  }

  // Parse & cross-check logic against condition count
  if (typeof logicRaw === 'string' && logicRaw.trim().length > 0 && conditions.length > 0) {
    try {
      const ast = parseLogic(logicRaw);
      const refs = collectIndices(ast);
      for (const ref of refs) {
        if (ref < 1 || ref > conditions.length) {
          errors.push(
            `'filters.logic' references condition ${ref}, but only ${conditions.length} conditions are defined.`
          );
        }
      }
    } catch (err) {
      if (err instanceof LogicParseError) {
        errors.push(`'filters.logic' is malformed: ${err.message}`);
      } else {
        errors.push(`'filters.logic' could not be parsed: ${(err as Error).message}`);
      }
    }
  }

  if (errors.length > 0) return null;

  return { conditions, logic: logicRaw as string };
}

function validateCondition(
  input: unknown,
  index: number,
  errors: string[]
): Condition | null {
  const prefix = `filters.conditions[${index}]`;
  if (!isObject(input)) {
    errors.push(`${prefix} must be an object.`);
    return null;
  }
  const obj = input as Record<string, unknown>;

  const field = obj.field;
  const operator = obj.operator;
  const value = obj.value;

  let ok = true;

  if (typeof field !== 'string' || field.trim().length === 0) {
    errors.push(`${prefix}.field must be a non-empty string.`);
    ok = false;
  }

  if (typeof operator !== 'string' || !SUPPORTED_OPERATORS.includes(operator as Operator)) {
    errors.push(
      `${prefix}.operator must be one of: ${SUPPORTED_OPERATORS.join(', ')}. Got '${String(operator)}'.`
    );
    ok = false;
  }

  if (operator === 'IN') {
    if (!Array.isArray(value)) {
      errors.push(`${prefix}.value must be an array when operator is IN.`);
      ok = false;
    } else if (value.length === 0) {
      errors.push(`${prefix}.value is an empty array (would produce invalid SOQL).`);
      ok = false;
    } else {
      for (let i = 0; i < value.length; i++) {
        if (!isScalar(value[i])) {
          errors.push(
            `${prefix}.value[${i}] must be a string, number, boolean, or null.`
          );
          ok = false;
        }
      }
    }
  } else if (operator === 'LIKE') {
    if (typeof value !== 'string') {
      errors.push(`${prefix}.value must be a string when operator is LIKE.`);
      ok = false;
    }
  } else {
    if (!isScalar(value)) {
      errors.push(
        `${prefix}.value must be a string, number, boolean, or null for operator ${operator}.`
      );
      ok = false;
    }
  }

  if (!ok) return null;
  return { field: field as string, operator: operator as Operator, value: value as any };
}

function validateUpdateFields(
  input: unknown,
  errors: string[]
): JobConfig['updateFields'] | null {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push(`'updateFields' must be a non-empty array.`);
    return null;
  }

  const result: JobConfig['updateFields'] = [];
  input.forEach((item, i) => {
    const prefix = `updateFields[${i}]`;
    if (!isObject(item)) {
      errors.push(`${prefix} must be an object.`);
      return;
    }
    const field = (item as Record<string, unknown>).field;
    const value = (item as Record<string, unknown>).value;

    if (typeof field !== 'string' || field.trim().length === 0) {
      errors.push(`${prefix}.field must be a non-empty string.`);
      return;
    }
    if (!isScalar(value)) {
      errors.push(`${prefix}.value must be a string, number, boolean, or null.`);
      return;
    }
    result.push({ field, value: value as any });
  });

  if (errors.length > 0) return null;
  return result;
}

// ============ Helpers ============

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isScalar(x: unknown): boolean {
  return (
    x === null ||
    typeof x === 'string' ||
    typeof x === 'number' ||
    typeof x === 'boolean'
  );
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  errors: string[]
): string | null {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push(`'${key}' is required and must be a non-empty string.`);
    return null;
  }
  return v;
}

function requirePositiveInt(
  obj: Record<string, unknown>,
  key: string,
  errors: string[]
): number | null {
  const v = obj[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    errors.push(`'${key}' is required and must be a positive integer.`);
    return null;
  }
  return v;
}