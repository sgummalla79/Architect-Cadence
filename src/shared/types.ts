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

/** Filters + update rules for a single execution (schedule or on-demand). */
export interface ScheduleConfig {
  filters: Filters;
  updateFields: UpdateField[];
}

/** A single field assignment in a call action's createRecords spec.
 *  `value` may contain the literal placeholder `{recordId}` which is
 *  substituted at runtime with the engagement record's Salesforce Id. */
export interface ActionField {
  field: string;
  value: string;
}

export interface CreateRecordConfig {
  object: string;
  fields: ActionField[];
}

/** Config for a simple patch-only button action (no child records). */
export interface SimpleAction {
  updateFields: UpdateField[];
}

/** @deprecated use SimpleAction */
export type EndCallAction = SimpleAction;

/** Config for one call-button action: patch the engagement + optionally create child records. */
export interface CallAction {
  /** Fields to update on the Engagement record itself. */
  updateFields: UpdateField[];
  /** Child records to create (e.g. Activity__c). Omit or leave empty to skip record creation. */
  createRecords?: CreateRecordConfig[];
}

/** Query config for the Engagements view tab. */
export interface EngagementsQuery {
  /** Additional fields to SELECT (beyond Id and ownerFieldName). */
  fields: string[];
  /** Filter conditions — same shape as dailySchedule.filters.conditions. */
  conditions: Condition[];
  /** Logic expression like "1 AND 2". 1-indexed into conditions. */
  logic: string;
}

/** Maps UI display slots to Salesforce field API names on the engagement object. */
export interface CardDisplayConfig {
  /** Field shown as the primary card name (Row 1). Defaults to 'Name'. */
  nameField?: string;
  /** Field shown as the subtitle row (Row 2). Defaults to 'Title__c'. */
  titleField?: string;
  /** Field shown as the stage badge. Defaults to 'Stage__c'. */
  stageField?: string;
  /** Field shown as the status badge and used for button-visibility logic. Defaults to 'Engagement_Status__c'. */
  statusField?: string;
}

export interface EngagementsViewConfig {
  query: EngagementsQuery;
  /** Duration options shown in the call duration dropdown, e.g. ["30s","1m","1h"]. */
  callDurations?: string[];
  /** Maps card UI slots to Salesforce field API names. All fields default if omitted. */
  cardDisplay?: CardDisplayConfig;
  /** Action executed when the External Call button is clicked on an engagement card. */
  customerCallAction?: CallAction;
  /** Action executed when the Internal Call button is clicked on an engagement card. */
  internalCallAction?: CallAction;
  /** Action executed when the End Call button is clicked on an engagement card. */
  endCallAction?: SimpleAction;
  /** Action executed when the Working / Waiting on Customer toggle is clicked. */
  workingAction?: SimpleAction;
}

/** The top-level job configuration shape. */
export interface JobConfig {
  domain: string;
  apiVersion: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  object: string;
  /** Field name (e.g. 'OwnerId') that is always constrained to the authenticated user. */
  ownerFieldName: string;
  /**
   * Guardrail: if SOQL returns more than this many records, the update is NOT performed.
   * The run is logged as an error.
   */
  maxRecords: number;
  /** Execution config used by both the daily scheduler and the Run Now button. */
  dailySchedule: ScheduleConfig;
  /** Optional config for the Engagements tab — fetches records on launch. */
  engagementsView?: EngagementsViewConfig;
}

/** Result of validating a config — either OK with parsed config, or errors with messages. */
export type ValidationResult =
  | { ok: true; config: JobConfig }
  | { ok: false; errors: string[] };