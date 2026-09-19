import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Real behavior test: extract the pure helpers from the shipped bundle and run them.
// No DOM needed; these two functions are dependency-free by design.
const src = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start !== -1, `${name} missing from app.js`);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const digitsOnly = new Function(`${extract('digitsOnly')}; return digitsOnly;`)();
const formatPhoneID = new Function(`${extract('digitsOnly')}\n${extract('formatPhoneID')}; return formatPhoneID;`)();
const formatPhoneLocal = new Function(`${extract('digitsOnly')}\n${extract('formatPhoneLocal')}; return formatPhoneLocal;`)();

test('digitsOnly strips every non-digit character', () => {
  assert.equal(digitsOnly('0812-3456-7890'), '081234567890');
  assert.equal(digitsOnly('12 34 56'), '123456');
  assert.equal(digitsOnly('abc123def456'), '123456');
  assert.equal(digitsOnly('+62 812-3456-7890'), '6281234567890');
  assert.equal(digitsOnly(''), '');
  assert.equal(digitsOnly(null), '');
  assert.equal(digitsOnly(undefined), '');
  assert.equal(digitsOnly(25000), '25000');
});

test('formatPhoneID normalizes Indonesian mobile numbers to +62', () => {
  assert.equal(formatPhoneID('081234567890'), '+6281234567890');
  assert.equal(formatPhoneID('0812-3456-7890'), '+6281234567890');
  assert.equal(formatPhoneID('6281234567890'), '+6281234567890');
  assert.equal(formatPhoneID('+62 812 3456 7890'), '+6281234567890');
  assert.equal(formatPhoneID('81234567890'), '+6281234567890');
  assert.equal(formatPhoneID('  0812 3456 7890  '), '+6281234567890');
  assert.equal(formatPhoneID(''), '');
  assert.equal(formatPhoneID('abc'), '');
});

test('formatPhoneID is idempotent (re-formatting a formatted value is stable)', () => {
  const once = formatPhoneID('081234567890');
  assert.equal(formatPhoneID(once), once);
  assert.equal(formatPhoneID(formatPhoneID(once)), once);
});

test('formatPhoneLocal keeps only the local part for a +62-prefixed field', () => {
  assert.equal(formatPhoneLocal('081234567890'), '81234567890');
  assert.equal(formatPhoneLocal('6281234567890'), '81234567890');
  assert.equal(formatPhoneLocal('+62 812 3456 7890'), '81234567890');
  assert.equal(formatPhoneLocal('81234567890'), '81234567890');
  assert.equal(formatPhoneLocal('0812-3456-7890'), '81234567890');
  assert.equal(formatPhoneLocal('abc'), '');
  assert.equal(formatPhoneLocal('8'), '8');
  // the local part re-forms the exact value the API validator accepts
  assert.equal(formatPhoneID(formatPhoneLocal('081234567890')), formatPhoneID('081234567890'));
  assert.equal(formatPhoneID(formatPhoneLocal('81234567890')), formatPhoneID('081234567890'));
});
