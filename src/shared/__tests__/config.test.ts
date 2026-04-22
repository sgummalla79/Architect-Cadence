import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, validateConfig } from '../config';

// A known-good config used as a base; tests mutate copies.
function goodConfig() {
  return {
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
  };
}

describe('validateConfig — happy path', () => {
  test('valid config returns ok with parsed shape', () => {
    const r = validateConfig(goodConfig());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.object).toBe('Engagement__c');
      expect(r.config.maxRecords).toBe(15);
      expect(r.config.dailySchedule.filters.conditions).toHaveLength(2);
      expect(r.config.logLevel).toBe('info');
    }
  });

  test('logLevel is optional', () => {
    const c = goodConfig();
    delete (c as any).logLevel;
    const r = validateConfig(c);
    expect(r.ok).toBe(true);
  });
});

describe('validateConfig — required top-level fields', () => {
  test.each([
    'domain',
    'apiVersion',
    'object',
    'ownerFieldName',
    'maxRecords',
  ])('missing %s fails', (field) => {
    const c: any = goodConfig();
    delete c[field];
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain(field);
    }
  });

  test('empty string for domain fails', () => {
    const c: any = goodConfig();
    c.domain = '';
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
  });

  test('non-object input fails cleanly', () => {
    expect(validateConfig(null).ok).toBe(false);
    expect(validateConfig('string').ok).toBe(false);
    expect(validateConfig([]).ok).toBe(false);
  });
});

describe('validateConfig — apiVersion format', () => {
  test('v66.0 passes', () => {
    expect(validateConfig(goodConfig()).ok).toBe(true);
  });

  test.each(['66.0', 'v66', 'v66.0.0', 'version66'])(
    'bad format %s fails',
    (bad) => {
      const c: any = goodConfig();
      c.apiVersion = bad;
      const r = validateConfig(c);
      expect(r.ok).toBe(false);
    }
  );
});

describe('validateConfig — maxRecords', () => {
  test.each([0, -1, 1.5, '15', null])('invalid value %p fails', (bad) => {
    const c: any = goodConfig();
    c.maxRecords = bad;
    expect(validateConfig(c).ok).toBe(false);
  });

  test('large positive integer passes', () => {
    const c: any = goodConfig();
    c.maxRecords = 10000;
    expect(validateConfig(c).ok).toBe(true);
  });
});

describe('validateConfig — dailySchedule.filters.conditions', () => {
  test('empty array fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions = [];
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
  });

  test('invalid operator fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions[0].operator = '~';
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain('operator');
    }
  });

  test('IN with non-array value fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions.push({ field: 'Id', operator: 'IN', value: ['abc'] });
    c.dailySchedule.filters.logic = '1 AND 2 AND 3';
    c.dailySchedule.filters.conditions[2].value = 'not-an-array';
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
  });

  test('IN with empty array fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions.push({ field: 'Id', operator: 'IN', value: [] });
    c.dailySchedule.filters.logic = '1 AND 2 AND 3';
    expect(validateConfig(c).ok).toBe(false);
  });

  test('= with array value fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions[0].value = ['a', 'b'];
    expect(validateConfig(c).ok).toBe(false);
  });

  test('LIKE with number fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions[0].operator = 'LIKE';
    c.dailySchedule.filters.conditions[0].value = 42;
    expect(validateConfig(c).ok).toBe(false);
  });

  test('missing field on condition fails', () => {
    const c: any = goodConfig();
    delete c.dailySchedule.filters.conditions[0].field;
    expect(validateConfig(c).ok).toBe(false);
  });

  test('all comparison operators accepted', () => {
    for (const op of ['=', '!=', '<', '>', '<=', '>=', 'LIKE']) {
      const c: any = goodConfig();
      c.dailySchedule.filters.conditions = [
        { field: 'F__c', operator: op, value: op === 'LIKE' ? 'abc%' : 5 },
      ];
      c.dailySchedule.filters.logic = '1';
      const r = validateConfig(c);
      expect(r.ok).toBe(true);
    }
  });
});

describe('validateConfig — dailySchedule.filters.logic', () => {
  test('empty logic fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.logic = '';
    expect(validateConfig(c).ok).toBe(false);
  });

  test('malformed logic fails with a clear message', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.logic = '1 AND';
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toMatch(/malformed|unexpected/i);
    }
  });

  test('out-of-range index fails with clear message', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.logic = '1 AND 5'; // only 2 conditions exist
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toContain('condition 5');
    }
  });

  test('nested logic with valid indices passes', () => {
    const c: any = goodConfig();
    c.dailySchedule.filters.conditions.push({ field: 'Extra__c', operator: '=', value: 'z' });
    c.dailySchedule.filters.logic = '1 AND (2 OR 3)';
    expect(validateConfig(c).ok).toBe(true);
  });
});

describe('validateConfig — dailySchedule.updateFields', () => {
  test('empty array fails', () => {
    const c: any = goodConfig();
    c.dailySchedule.updateFields = [];
    expect(validateConfig(c).ok).toBe(false);
  });

  test('update value can be null', () => {
    const c: any = goodConfig();
    c.dailySchedule.updateFields = [{ field: 'F__c', value: null }];
    expect(validateConfig(c).ok).toBe(true);
  });

  test('missing field throws', () => {
    const c: any = goodConfig();
    c.dailySchedule.updateFields = [{ value: 'x' }];
    expect(validateConfig(c).ok).toBe(false);
  });
});

describe('loadConfig — file I/O', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('reads and validates a valid file', () => {
    const p = path.join(tmpDir, 'good.json');
    fs.writeFileSync(p, JSON.stringify(goodConfig()));
    const r = loadConfig(p);
    expect(r.ok).toBe(true);
  });

  test('missing file returns error', () => {
    const r = loadConfig(path.join(tmpDir, 'nope.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Could not read/);
  });

  test('invalid JSON returns error', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ not valid json');
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/not valid JSON/);
  });

  test('valid JSON but invalid schema returns errors', () => {
    const p = path.join(tmpDir, 'schema.json');
    fs.writeFileSync(p, JSON.stringify({ foo: 'bar' }));
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  test('collects multiple errors, not just the first', () => {
    const p = path.join(tmpDir, 'multi.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        // Missing: domain, apiVersion, object, ownerFieldName, maxRecords, filters, updateFields
        logLevel: 'info',
      })
    );
    const r = loadConfig(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(5);
  });
});