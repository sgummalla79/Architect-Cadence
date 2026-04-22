// Config loader + validator.
// Reads a JSON file from disk and validates it against the JobConfig shape.
// Returns structured errors rather than throwing, so the UI can display them clearly.

import * as fs from 'fs';
import {
  ActionField,
  CallAction,
  CardDisplayConfig,
  Condition,
  CreateRecordConfig,
  EngagementsQuery,
  EngagementsViewConfig,
  Filters,
  JobConfig,
  Operator,
  SimpleAction,
  SUPPORTED_OPERATORS,
  UpdateField,
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

  // dailySchedule
  const rawSchedule = (input as Record<string, unknown>).dailySchedule;
  if (!isObject(rawSchedule)) {
    errors.push(`'dailySchedule' is required and must be an object.`);
  }

  const scheduleObj = isObject(rawSchedule) ? rawSchedule : {};
  const filters = validateFilters(scheduleObj.filters, errors);
  const updateFields = validateUpdateFields(scheduleObj.updateFields, errors);

  // engagementsView (optional) — includes all card button action configs
  let engagementsView: EngagementsViewConfig | undefined;
  if ('engagementsView' in input) {
    const rawEv = (input as Record<string, unknown>).engagementsView;
    engagementsView = validateEngagementsView(rawEv, errors) ?? undefined;
  }

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
    dailySchedule: { filters: filters!, updateFields: updateFields! },
  };
  if ('logLevel' in input) {
    config.logLevel = (input as { logLevel: JobConfig['logLevel'] }).logLevel;
  }
  if (engagementsView) config.engagementsView = engagementsView;
  return { ok: true, config };
}

// ============ Sub-validators ============

function validateFilters(
  input: unknown,
  errors: string[]
): Filters | null {
  if (!isObject(input)) {
    errors.push(`'dailySchedule.filters' is required and must be an object.`);
    return null;
  }

  const conditionsRaw = (input as Record<string, unknown>).conditions;
  const logicRaw = (input as Record<string, unknown>).logic;

  if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) {
    errors.push(`'dailySchedule.filters.conditions' must be a non-empty array.`);
  }

  if (typeof logicRaw !== 'string' || logicRaw.trim().length === 0) {
    errors.push(`'dailySchedule.filters.logic' must be a non-empty string.`);
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
        errors.push(`'dailySchedule.filters.logic' is malformed: ${err.message}`);
      } else {
        errors.push(`'dailySchedule.filters.logic' could not be parsed: ${(err as Error).message}`);
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
  const prefix = `dailySchedule.filters.conditions[${index}]`;
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
): UpdateField[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push(`'dailySchedule.updateFields' must be a non-empty array.`);
    return null;
  }

  const result: UpdateField[] = [];
  input.forEach((item, i) => {
    const prefix = `dailySchedule.updateFields[${i}]`;
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

function validateSimpleAction(
  input: unknown,
  key: string,
  errors: string[]
): SimpleAction | null {
  if (!isObject(input)) {
    errors.push(`'${key}' must be an object.`);
    return null;
  }
  const fields = validateCallActionUpdateFields(
    (input as Record<string, unknown>).updateFields, key, errors
  );
  if (!fields) return null;
  return { updateFields: fields };
}

function validateCallAction(
  input: unknown,
  key: string,
  errors: string[]
): CallAction | null {
  if (!isObject(input)) {
    errors.push(`'${key}' must be an object.`);
    return null;
  }

  const updateFields = validateCallActionUpdateFields(
    (input as Record<string, unknown>).updateFields, key, errors
  );

  const rawCreate = (input as Record<string, unknown>).createRecords;
  let createRecords: CreateRecordConfig[] | null | undefined;
  if (rawCreate !== undefined) {
    if (!Array.isArray(rawCreate)) {
      errors.push(`'${key}.createRecords' must be an array.`);
    } else if (rawCreate.length > 0) {
      createRecords = validateCreateRecords(rawCreate, key, errors);
    }
  }

  if (errors.length > 0) return null;
  const result: CallAction = { updateFields: updateFields! };
  if (createRecords && createRecords.length > 0) result.createRecords = createRecords;
  return result;
}

function validateCallActionUpdateFields(
  input: unknown,
  key: string,
  errors: string[]
): UpdateField[] | null {
  if (!Array.isArray(input) || input.length === 0) {
    errors.push(`'${key}.updateFields' must be a non-empty array.`);
    return null;
  }
  const result: UpdateField[] = [];
  input.forEach((item, i) => {
    const prefix = `${key}.updateFields[${i}]`;
    if (!isObject(item)) { errors.push(`${prefix} must be an object.`); return; }
    const field = (item as Record<string, unknown>).field;
    const value = (item as Record<string, unknown>).value;
    if (typeof field !== 'string' || field.trim().length === 0) {
      errors.push(`${prefix}.field must be a non-empty string.`); return;
    }
    if (!isScalar(value)) {
      errors.push(`${prefix}.value must be a string, number, boolean, or null.`); return;
    }
    result.push({ field, value: value as any });
  });
  return result.length > 0 ? result : null;
}

function validateCreateRecords(
  input: unknown[],
  key: string,
  errors: string[]
): CreateRecordConfig[] | null {
  const result: CreateRecordConfig[] = [];
  input.forEach((item, i) => {
    const prefix = `${key}.createRecords[${i}]`;
    if (!isObject(item)) { errors.push(`${prefix} must be an object.`); return; }
    const object = (item as Record<string, unknown>).object;
    const fields = (item as Record<string, unknown>).fields;
    if (typeof object !== 'string' || object.trim().length === 0) {
      errors.push(`${prefix}.object must be a non-empty string.`); return;
    }
    if (!Array.isArray(fields) || fields.length === 0) {
      errors.push(`${prefix}.fields must be a non-empty array.`); return;
    }
    const parsedFields: ActionField[] = [];
    (fields as unknown[]).forEach((f, j) => {
      const fp = `${prefix}.fields[${j}]`;
      if (!isObject(f)) { errors.push(`${fp} must be an object.`); return; }
      const fField = (f as Record<string, unknown>).field;
      const fValue = (f as Record<string, unknown>).value;
      const fSoql  = (f as Record<string, unknown>).soql;
      const fSoqlResultField = (f as Record<string, unknown>).soqlResultField;
      if (typeof fField !== 'string' || fField.trim().length === 0) {
        errors.push(`${fp}.field must be a non-empty string.`); return;
      }
      if (fSoql !== undefined) {
        if (typeof fSoql !== 'string' || fSoql.trim().length === 0) {
          errors.push(`${fp}.soql must be a non-empty string.`); return;
        }
        if (fSoqlResultField !== undefined && typeof fSoqlResultField !== 'string') {
          errors.push(`${fp}.soqlResultField must be a string.`); return;
        }
        parsedFields.push({ field: fField, soql: fSoql, soqlResultField: typeof fSoqlResultField === 'string' ? fSoqlResultField : 'Id' });
      } else {
        if (typeof fValue !== 'string') {
          errors.push(`${fp}: either 'value' (string) or 'soql' (string) must be provided.`); return;
        }
        parsedFields.push({ field: fField, value: fValue });
      }
    });
    result.push({ object: object.trim(), fields: parsedFields });
  });
  return result.length > 0 ? result : null;
}

function validateEngagementsView(
  input: unknown,
  errors: string[]
): EngagementsViewConfig | null {
  if (!isObject(input)) {
    errors.push(`'engagementsView' must be an object.`);
    return null;
  }

  const queryRaw = (input as Record<string, unknown>).query;
  if (!isObject(queryRaw)) {
    errors.push(`'engagementsView.query' is required and must be an object.`);
    return null;
  }

  const q = queryRaw as Record<string, unknown>;

  if (!Array.isArray(q.fields) || q.fields.length === 0) {
    errors.push(`'engagementsView.query.fields' must be a non-empty array.`);
  } else {
    for (let i = 0; i < q.fields.length; i++) {
      if (typeof q.fields[i] !== 'string' || (q.fields[i] as string).trim().length === 0) {
        errors.push(`'engagementsView.query.fields[${i}]' must be a non-empty string.`);
      }
    }
  }

  if (!Array.isArray(q.conditions) || q.conditions.length === 0) {
    errors.push(`'engagementsView.query.conditions' must be a non-empty array.`);
  }

  if (typeof q.logic !== 'string' || q.logic.trim().length === 0) {
    errors.push(`'engagementsView.query.logic' must be a non-empty string.`);
  }

  const conditions: Condition[] = [];
  if (Array.isArray(q.conditions)) {
    q.conditions.forEach((c, i) => {
      const parsed = validateEngagementCondition(c, i, errors);
      if (parsed) conditions.push(parsed);
    });
  }

  if (typeof q.logic === 'string' && q.logic.trim().length > 0 && conditions.length > 0) {
    try {
      const ast = parseLogic(q.logic);
      const refs = collectIndices(ast);
      for (const ref of refs) {
        if (ref < 1 || ref > conditions.length) {
          errors.push(
            `'engagementsView.query.logic' references condition ${ref}, but only ${conditions.length} conditions are defined.`
          );
        }
      }
    } catch (err) {
      if (err instanceof LogicParseError) {
        errors.push(`'engagementsView.query.logic' is malformed: ${err.message}`);
      } else {
        errors.push(`'engagementsView.query.logic' could not be parsed: ${(err as Error).message}`);
      }
    }
  }

  if (errors.length > 0) return null;

  const query: EngagementsQuery = {
    fields: (q.fields as string[]).map((f) => f.trim()),
    conditions,
    logic: q.logic as string,
  };

  const ev = input as Record<string, unknown>;
  const result: EngagementsViewConfig = { query };

  if ('callDurations' in ev) {
    const raw = ev.callDurations;
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((d) => typeof d !== 'string' || d.trim().length === 0)) {
      errors.push(`'engagementsView.callDurations' must be a non-empty array of non-empty strings.`);
    } else {
      result.callDurations = raw.map((d) => (d as string).trim());
    }
  }

  if ('customerCallAction' in ev)
    result.customerCallAction = validateCallAction(ev.customerCallAction, 'engagementsView.customerCallAction', errors) ?? undefined;
  if ('internalCallAction' in ev)
    result.internalCallAction = validateCallAction(ev.internalCallAction, 'engagementsView.internalCallAction', errors) ?? undefined;
  if ('endCallAction' in ev)
    result.endCallAction = validateSimpleAction(ev.endCallAction, 'engagementsView.endCallAction', errors) ?? undefined;
  if ('workingAction' in ev)
    result.workingAction = validateSimpleAction(ev.workingAction, 'engagementsView.workingAction', errors) ?? undefined;

  if ('cardDisplay' in ev) {
    const cd = ev.cardDisplay;
    if (!isObject(cd)) {
      errors.push(`'engagementsView.cardDisplay' must be an object.`);
    } else {
      const cardDisplay: CardDisplayConfig = {};
      for (const key of ['nameField', 'titleField', 'stageField', 'statusField'] as const) {
        if (key in cd) {
          const v = cd[key];
          if (typeof v !== 'string' || v.trim().length === 0) {
            errors.push(`'engagementsView.cardDisplay.${key}' must be a non-empty string.`);
          } else {
            cardDisplay[key] = v.trim();
          }
        }
      }
      result.cardDisplay = cardDisplay;
    }
  }

  return result;
}

function validateEngagementCondition(
  input: unknown,
  index: number,
  errors: string[]
): Condition | null {
  const prefix = `engagementsView.query.conditions[${index}]`;
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
    }
  } else if (operator === 'LIKE') {
    if (typeof value !== 'string') {
      errors.push(`${prefix}.value must be a string when operator is LIKE.`);
      ok = false;
    }
  } else {
    if (!isScalar(value)) {
      errors.push(`${prefix}.value must be a string, number, boolean, or null for operator ${String(operator)}.`);
      ok = false;
    }
  }

  if (!ok) return null;
  return { field: field as string, operator: operator as Operator, value: value as any };
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