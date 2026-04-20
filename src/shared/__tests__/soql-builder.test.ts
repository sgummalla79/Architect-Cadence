import { buildSoql, renderCondition } from '../soql-builder';
import { JobConfig } from '../types';

// A minimal valid config for tests, easy to mutate per-test.
function makeConfig(overrides: Partial<JobConfig> = {}): JobConfig {
  return {
    domain: 'exp-cloud.my.salesforce.com',
    apiVersion: 'v66.0',
    object: 'Student__c',
    ownerFieldName: 'OwnerId',
    maxRecords: 15,
    filters: {
      conditions: [
        { field: 'Final_Result__c', operator: '=', value: 'Withdrawn' },
      ],
      logic: '1',
    },
    updateFields: [{ field: 'Final_Result__c', value: 'Distinction' }],
    ...overrides,
  };
}

describe('renderCondition', () => {
  test('string equality', () => {
    expect(
      renderCondition({ field: 'Name', operator: '=', value: 'Foo' })
    ).toBe(`Name = 'Foo'`);
  });

  test('escapes single quotes in strings', () => {
    expect(
      renderCondition({ field: 'Name', operator: '=', value: "O'Brien" })
    ).toBe(`Name = 'O\\'Brien'`);
  });

  test('escapes backslashes before quotes', () => {
    expect(
      renderCondition({ field: 'Note', operator: '=', value: 'back\\slash' })
    ).toBe(`Note = 'back\\\\slash'`);
  });

  test('number equality', () => {
    expect(
      renderCondition({ field: 'Amount__c', operator: '=', value: 42 })
    ).toBe(`Amount__c = 42`);
  });

  test('boolean equality', () => {
    expect(
      renderCondition({ field: 'Active__c', operator: '=', value: true })
    ).toBe(`Active__c = TRUE`);
  });

  test('null value renders as NULL', () => {
    expect(
      renderCondition({ field: 'Foo__c', operator: '=', value: null })
    ).toBe(`Foo__c = NULL`);
  });

  test('LIKE with wildcards', () => {
    expect(
      renderCondition({ field: 'Name', operator: 'LIKE', value: 'Acme%' })
    ).toBe(`Name LIKE 'Acme%'`);
  });

  test('IN with multiple strings', () => {
    expect(
      renderCondition({
        field: 'Id',
        operator: 'IN',
        value: ['a1', 'a2', 'a3'],
      })
    ).toBe(`Id IN ('a1', 'a2', 'a3')`);
  });

  test('IN with numbers', () => {
    expect(
      renderCondition({
        field: 'Amount__c',
        operator: 'IN',
        value: [10, 20, 30],
      })
    ).toBe(`Amount__c IN (10, 20, 30)`);
  });

  test('comparison operators', () => {
    expect(
      renderCondition({ field: 'Age__c', operator: '<', value: 18 })
    ).toBe(`Age__c < 18`);
    expect(
      renderCondition({ field: 'Age__c', operator: '>=', value: 18 })
    ).toBe(`Age__c >= 18`);
    expect(
      renderCondition({ field: 'Age__c', operator: '!=', value: 0 })
    ).toBe(`Age__c != 0`);
  });

  test('ISO date strings are rendered unquoted (SOQL date literal)', () => {
    expect(
      renderCondition({
        field: 'CreatedDate',
        operator: '>',
        value: '2024-01-01T00:00:00Z',
      })
    ).toBe(`CreatedDate > 2024-01-01T00:00:00Z`);
  });

  test('SOQL named date literals are rendered unquoted', () => {
    expect(
      renderCondition({ field: 'CreatedDate', operator: '>', value: 'TODAY' })
    ).toBe(`CreatedDate > TODAY`);
    expect(
      renderCondition({
        field: 'CreatedDate',
        operator: '=',
        value: 'LAST_N_DAYS:7',
      })
    ).toBe(`CreatedDate = LAST_N_DAYS:7`);
  });

  test('IN with non-array value throws', () => {
    expect(() =>
      renderCondition({ field: 'Id', operator: 'IN', value: 'a1' as any })
    ).toThrow(/IN but value is not an array/);
  });

  test('IN with empty array throws', () => {
    expect(() =>
      renderCondition({ field: 'Id', operator: 'IN', value: [] })
    ).toThrow(/empty array/);
  });

  test('= with array value throws', () => {
    expect(() =>
      renderCondition({
        field: 'Id',
        operator: '=',
        value: ['a1'] as any,
      })
    ).toThrow(/but value is an array/);
  });

  test('LIKE with non-string throws', () => {
    expect(() =>
      renderCondition({ field: 'X', operator: 'LIKE', value: 42 as any })
    ).toThrow(/LIKE but value is not a string/);
  });
});

describe('buildSoql — structure', () => {
  test('simple single-condition query', () => {
    const config = makeConfig();
    const { soql, whereExpression } = buildSoql(config, { currentUserId: '005ABC' });

    expect(soql).toBe(
      `SELECT Id, OwnerId FROM Student__c ` +
        `WHERE Final_Result__c = 'Withdrawn' AND OwnerId = '005ABC' ` +
        `LIMIT 16`
    );
    expect(whereExpression).toBe(
      `Final_Result__c = 'Withdrawn' AND OwnerId = '005ABC'`
    );
  });

  test('matches the spec example: "1 AND 2" with string + IN', () => {
    const config = makeConfig({
      filters: {
        conditions: [
          { field: 'Final_Result__c', operator: '=', value: 'Withdrawn' },
          {
            field: 'Id',
            operator: 'IN',
            value: ['a0uKd00000L6xfQIAR', 'a0uKd00000L6xfRIAR', 'a0uKd00000L6xkpIAB'],
          },
        ],
        logic: '1 AND 2',
      },
    });
    const { soql } = buildSoql(config, { currentUserId: '005XXXX' });

    expect(soql).toContain(`SELECT Id, OwnerId FROM Student__c`);
    expect(soql).toContain(
      `(Final_Result__c = 'Withdrawn' AND Id IN ('a0uKd00000L6xfQIAR', 'a0uKd00000L6xfRIAR', 'a0uKd00000L6xkpIAB'))`
    );
    expect(soql).toContain(`AND OwnerId = '005XXXX'`);
    expect(soql).toMatch(/LIMIT 16$/);
  });

  test('nested logic "1 AND (2 OR 3)"', () => {
    const config = makeConfig({
      filters: {
        conditions: [
          { field: 'A__c', operator: '=', value: 1 },
          { field: 'B__c', operator: '=', value: 2 },
          { field: 'C__c', operator: '=', value: 3 },
        ],
        logic: '1 AND (2 OR 3)',
      },
    });
    const { whereExpression } = buildSoql(config, { currentUserId: '005' });

    // AST: AND(1, OR(2, 3))  →  (A__c = 1 AND (B__c = 2 OR C__c = 3))
    expect(whereExpression).toBe(
      `(A__c = 1 AND (B__c = 2 OR C__c = 3)) AND OwnerId = '005'`
    );
  });

  test('owner filter is always appended with AND, even when logic is a single OR', () => {
    const config = makeConfig({
      filters: {
        conditions: [
          { field: 'A__c', operator: '=', value: 1 },
          { field: 'B__c', operator: '=', value: 2 },
        ],
        logic: '1 OR 2',
      },
    });
    const { whereExpression } = buildSoql(config, { currentUserId: '005' });

    // Owner filter must be outside the user's OR expression.
    expect(whereExpression).toBe(
      `(A__c = 1 OR B__c = 2) AND OwnerId = '005'`
    );
  });

  test('LIMIT equals maxRecords + 1 for guardrail check', () => {
    const config = makeConfig({ maxRecords: 50 });
    const { soql } = buildSoql(config, { currentUserId: '005' });
    expect(soql).toMatch(/LIMIT 51$/);
  });

  test('LIMIT with maxRecords = 1', () => {
    const config = makeConfig({ maxRecords: 1 });
    const { soql } = buildSoql(config, { currentUserId: '005' });
    expect(soql).toMatch(/LIMIT 2$/);
  });

  test('ownerFieldName is escaped into owner filter', () => {
    const config = makeConfig({ ownerFieldName: 'Assigned_To__c' });
    const { soql } = buildSoql(config, { currentUserId: '005' });
    expect(soql).toContain(`SELECT Id, Assigned_To__c FROM`);
    expect(soql).toContain(`Assigned_To__c = '005'`);
  });

  test('deduplicates SELECT fields when ownerFieldName is Id', () => {
    const config = makeConfig({ ownerFieldName: 'Id' });
    const { soql } = buildSoql(config, { currentUserId: '005' });
    expect(soql).toMatch(/^SELECT Id FROM /);
  });

  test('escapes single quotes in user Id', () => {
    const config = makeConfig();
    const { whereExpression } = buildSoql(config, {
      currentUserId: "005'; DROP TABLE--",
    });
    expect(whereExpression).toContain(`'005\\'; DROP TABLE--'`);
  });

  test('throws if currentUserId is empty', () => {
    const config = makeConfig();
    expect(() => buildSoql(config, { currentUserId: '' })).toThrow(
      /currentUserId is required/
    );
  });

  test('throws if ownerFieldName is empty', () => {
    const config = makeConfig({ ownerFieldName: '' } as any);
    expect(() => buildSoql(config, { currentUserId: '005abc' })).toThrow(
      /ownerFieldName is required/
    );
  });

  test('throws if logic references out-of-range condition', () => {
    const config = makeConfig({
      filters: {
        conditions: [{ field: 'A__c', operator: '=', value: 1 }],
        logic: '1 AND 5',
      },
    });
    expect(() => buildSoql(config, { currentUserId: '005' })).toThrow(
      /Logic references condition 5/
    );
  });
});