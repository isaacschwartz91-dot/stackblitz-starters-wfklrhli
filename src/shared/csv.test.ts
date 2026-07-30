import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { toCsv } from './csv';

describe('CSV exports', () => {
  test('neutralize spreadsheet formulas in user-provided cells', () => {
    const csv = toCsv([
      ['name', 'referral'],
      ['=HYPERLINK("https://example.test")', '+1+1'],
      ['-10', '@SUM(A1:A2)'],
    ]);

    assert.match(csv, /'=HYPERLINK/);
    assert.match(csv, /'\+1\+1/);
    assert.match(csv, /'-10/);
    assert.match(csv, /'@SUM/);
  });
});
