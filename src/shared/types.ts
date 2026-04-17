// Type definitions for the job configuration and SOQL output.
// These are pure types — no runtime code.

/** Supported SOQL comparison operators in our config. */
export type Operator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'LIKE' | 'IN';

export const SUPPORTED_OPERATORS: ReadonlyArray<Operator> = [
  '=', '!=', '<', '>', '<=', '>=', 'LIKE', 'IN',
];

/** A scalar value usable in an SOQL comparison. */
export type ScalarValue = string | number | boolean | null;

/** A single filter condition, e.g. { field: "Name", operator: "=", value: "Foo" }. */
export interface Condition {
  field: string;
  operator: Operator;
  /** Array required for IN operator; scalar for all others. */
  value: ScalarValue | ScalarValue[];
}

export interface Filters {
  conditions: Condition[];
  /** Expression like "1 AND 2" or "1 AND (2 OR 3)". 1-indexed into conditions. */
  logic: string;
}

export interface UpdateField {
  field: string;
  value: ScalarValue;
}

/** The top-level job configuration shape. */
export interface JobConfig {
  domain: string;
  apiVersion: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  object: string;
  filters: Filters;
  /** Field name (e.g. 'OwnerId') that is always constrained to the authenticated user. */
  ownerFieldName: string;
  updateFields: UpdateField[];
  /**
   * Guardrail: if SOQL returns more than this many records, the update is NOT performed.
   * The run is logged as an error.
   */
  maxRecords: number;
}

/** Result of validating a config — either OK with parsed config, or errors with messages. */
export type ValidationResult =
  | { ok: true; config: JobConfig }
  | { ok: false; errors: string[] };