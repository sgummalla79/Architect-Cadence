// Builds SOQL queries from a validated JobConfig + current user Id.
//
// The query structure is always:
//   SELECT Id, <ownerFieldName> FROM <object>
//   WHERE (<logic-expression>) AND <ownerFieldName> = '<userId>'
//   LIMIT <maxRecords + 1>
//
// The +1 on LIMIT is an efficiency trick for the guardrail check: we only need
// to know whether the row count *exceeds* maxRecords, not fetch everything beyond it.

import { Condition, JobConfig, Operator, ScalarValue } from './types';
import { LogicNode, collectIndices, parseLogic } from './logic-parser';

// ============ SOQL value escaping ============

/** Escape a string for use inside a single-quoted SOQL literal. */
function escapeStringLiteral(s: string): string {
  // Order matters: escape backslashes first, then single quotes.
  // SOQL also requires escaping newlines, carriage returns, and tabs.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Render a scalar value as a SOQL literal. */
function renderScalar(v: ScalarValue): string {
  if (v === null) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new Error(`Non-finite number cannot be rendered as SOQL: ${v}`);
    }
    return String(v);
  }
  // String — check for special SOQL date/datetime literals (unquoted).
  // Salesforce date literals like TODAY, YESTERDAY, LAST_N_DAYS:5 should pass
  // through un-escaped. We detect them conservatively.
  if (isSoqlDateLiteral(v)) return v;
  return `'${escapeStringLiteral(v)}'`;
}

/**
 * Return true if the string looks like a SOQL date/datetime literal or date-function
 * (e.g. TODAY, YESTERDAY, LAST_N_DAYS:5, 2024-01-01, 2024-01-01T00:00:00Z).
 * We only treat these as bare literals if the user explicitly opts in by using
 * these exact shapes; anything else gets quoted as a string.
 */
function isSoqlDateLiteral(s: string): boolean {
  // ISO date: 2024-01-01
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
  // ISO datetime with timezone: 2024-01-01T00:00:00Z or with offset
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return true;
  // Named literals: TODAY, YESTERDAY, TOMORROW, THIS_WEEK, LAST_WEEK, etc.
  if (/^(TODAY|YESTERDAY|TOMORROW|THIS_WEEK|LAST_WEEK|NEXT_WEEK|THIS_MONTH|LAST_MONTH|NEXT_MONTH|THIS_QUARTER|LAST_QUARTER|NEXT_QUARTER|THIS_YEAR|LAST_YEAR|NEXT_YEAR|THIS_FISCAL_QUARTER|LAST_FISCAL_QUARTER|NEXT_FISCAL_QUARTER|THIS_FISCAL_YEAR|LAST_FISCAL_YEAR|NEXT_FISCAL_YEAR)$/.test(s)) {
    return true;
  }
  // Parameterized literals: LAST_N_DAYS:5, NEXT_N_DAYS:7, LAST_N_WEEKS:2, etc.
  if (/^(LAST_N_DAYS|NEXT_N_DAYS|LAST_N_WEEKS|NEXT_N_WEEKS|LAST_N_MONTHS|NEXT_N_MONTHS|LAST_N_QUARTERS|NEXT_N_QUARTERS|LAST_N_YEARS|NEXT_N_YEARS|LAST_N_FISCAL_QUARTERS|NEXT_N_FISCAL_QUARTERS|LAST_N_FISCAL_YEARS|NEXT_N_FISCAL_YEARS):\d+$/.test(s)) {
    return true;
  }
  return false;
}

// ============ Condition rendering ============

/** Render a single condition to a SOQL fragment like "Name = 'Foo'" or "Id IN ('a','b')". */
export function renderCondition(cond: Condition): string {
  validateCondition(cond);
  const { field, operator, value } = cond;

  if (operator === 'IN') {
    const arr = value as ScalarValue[];
    const items = arr.map(renderScalar).join(', ');
    return `${field} IN (${items})`;
  }

  // All other operators take a scalar.
  return `${field} ${operator} ${renderScalar(value as ScalarValue)}`;
}

/** Throws if the condition shape doesn't match its operator. */
function validateCondition(cond: Condition): void {
  if (!cond.field || typeof cond.field !== 'string') {
    throw new Error(`Condition is missing 'field'.`);
  }
  if (cond.operator === 'IN') {
    if (!Array.isArray(cond.value)) {
      throw new Error(
        `Condition on '${cond.field}' uses IN but value is not an array.`
      );
    }
    if (cond.value.length === 0) {
      throw new Error(
        `Condition on '${cond.field}' uses IN with an empty array (would produce invalid SOQL).`
      );
    }
  } else {
    if (Array.isArray(cond.value)) {
      throw new Error(
        `Condition on '${cond.field}' uses ${cond.operator} but value is an array. Use IN for array values.`
      );
    }
  }
  if (cond.operator === 'LIKE' && typeof cond.value !== 'string') {
    throw new Error(
      `Condition on '${cond.field}' uses LIKE but value is not a string.`
    );
  }
}

// ============ AST rendering ============

/** Walk the logic AST and render the WHERE expression, wrapping nested nodes in parens. */
function renderLogic(node: LogicNode, conditions: Condition[]): string {
  switch (node.type) {
    case 'index': {
      const idx = node.value - 1; // logic expression is 1-indexed
      const cond = conditions[idx];
      if (!cond) {
        throw new Error(
          `Logic references condition ${node.value}, but only ${conditions.length} conditions are defined.`
        );
      }
      return renderCondition(cond);
    }
    case 'and':
      return `(${renderLogic(node.left, conditions)} AND ${renderLogic(node.right, conditions)})`;
    case 'or':
      return `(${renderLogic(node.left, conditions)} OR ${renderLogic(node.right, conditions)})`;
  }
}

// ============ Top-level build ============

export interface BuildSoqlOptions {
  /** The Salesforce user Id that the owner filter is scoped to. */
  currentUserId: string;
}

export interface BuiltSoql {
  /** The full SOQL query to execute. */
  soql: string;
  /** The WHERE expression alone (without SELECT/FROM/LIMIT), useful for debugging. */
  whereExpression: string;
}

/**
 * Build a SOQL query from a validated JobConfig.
 *
 * Important behaviors:
 *   - Owner filter is ALWAYS appended with AND, regardless of the user's logic.
 *   - LIMIT is `maxRecords + 1` so the guardrail can detect "too many matches" efficiently.
 *   - Both `Id` and the owner field are selected so update rows know who owns them.
 */
export function buildSoql(config: JobConfig, options: BuildSoqlOptions): BuiltSoql {
  if (!options.currentUserId) {
    throw new Error('currentUserId is required to build the SOQL query.');
  }

  const ast = parseLogic(config.filters.logic);

  // Sanity check: logic expression should only reference valid condition indices.
  const refs = collectIndices(ast);
  for (const ref of refs) {
    if (ref < 1 || ref > config.filters.conditions.length) {
      throw new Error(
        `Logic references condition ${ref}, but only ${config.filters.conditions.length} conditions are defined.`
      );
    }
  }

  const userLogicExpr = renderLogic(ast, config.filters.conditions);
  const ownerFilter = `${config.ownerFieldName} = '${escapeStringLiteral(options.currentUserId)}'`;
  // Note: renderLogic already wraps compound nodes (AND/OR) in parens, so no outer
  // wrap is needed when combining with the owner filter. Leaf conditions
  // (single index) don't need wrapping either because `=` binds tighter than AND in SOQL.
  const whereExpression = `${userLogicExpr} AND ${ownerFilter}`;

  // Deduplicate in case ownerFieldName === 'Id' or similar.
  const selectFields = Array.from(new Set(['Id', config.ownerFieldName]));

  const soql =
    `SELECT ${selectFields.join(', ')} FROM ${config.object} ` +
    `WHERE ${whereExpression} ` +
    `LIMIT ${config.maxRecords + 1}`;

  return { soql, whereExpression };
}

// Re-export operator helpers so callers can import everything from soql-builder.
export type { Operator, Condition, JobConfig };