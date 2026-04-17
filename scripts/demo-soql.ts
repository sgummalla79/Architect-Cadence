// Run this with: npx ts-node scripts/demo-soql.ts
// Or after compile: node dist/scripts/demo-soql.js
//
// Prints the SOQL generated from the exact config from the spec,
// so you can eyeball what the app will actually send to Salesforce.

import { buildSoql, validateConfig } from '../src/shared';

const specExample = {
  domain: 'exp-cloud.my.salesforce.com',
  apiVersion: 'v66.0',
  logLevel: 'info',
  object: 'Student__c',
  filters: {
    conditions: [
      { field: 'Final_Result__c', operator: '=', value: 'Withdrawn' },
      {
        field: 'Id',
        operator: 'IN',
        value: [
          'a0uKd00000L6xfQIAR',
          'a0uKd00000L6xfRIAR',
          'a0uKd00000L6xkpIAB',
        ],
      },
    ],
    logic: '1 AND 2',
  },
  ownerFieldName: 'OwnerId',
  updateFields: [{ field: 'Final_Result__c', value: 'Distinction' }],
  maxRecords: 15,
};

const result = validateConfig(specExample);
if (!result.ok) {
  console.error('Config invalid:');
  for (const e of result.errors) console.error(' -', e);
  process.exit(1);
}

const userId = '005A0000001abcdXYZ'; // stand-in for the logged-in user
const { soql, whereExpression } = buildSoql(result.config, { currentUserId: userId });

console.log('=== WHERE expression ===');
console.log(whereExpression);
console.log();
console.log('=== Full SOQL (this is what will be sent to Salesforce) ===');
console.log(soql);
console.log();
console.log('=== Guardrail behavior ===');
console.log(
  `Query limits to ${result.config.maxRecords + 1} rows. If >${
    result.config.maxRecords
  } match, the update is SKIPPED and an error is logged.`
);