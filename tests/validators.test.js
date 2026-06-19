/**
 * @file validators.test.js
 * @description Unit tests for the shared pure validators in services/validators.js
 * (sheet-name and hex-color validation), covering both valid and invalid inputs and
 * non-string types.
 */

import test from 'node:test';
import assert from 'node:assert';
import { isValidSheetName, isValidHexColor } from '../services/validators.js';

test('isValidSheetName accepts 2-30 letters/digits/spaces and rejects everything else', () => {
  assert.strictEqual(isValidSheetName('Sheet1'), true);
  assert.strictEqual(isValidSheetName('My Sheet'), true);
  assert.strictEqual(isValidSheetName('数据 2024'), true, 'Unicode letters are allowed');

  assert.strictEqual(isValidSheetName('A'), false, 'too short (<2)');
  assert.strictEqual(isValidSheetName('x'.repeat(31)), false, 'too long (>30)');
  assert.strictEqual(isValidSheetName('Bad/Name'), false, 'punctuation rejected');
  assert.strictEqual(isValidSheetName(''), false);
  assert.strictEqual(isValidSheetName(123), false, 'non-string rejected');
  assert.strictEqual(isValidSheetName(null), false);
  assert.strictEqual(isValidSheetName(undefined), false);
});

test('isValidHexColor accepts 6-digit hex colors and rejects everything else', () => {
  assert.strictEqual(isValidHexColor('#1a2b3c'), true);
  assert.strictEqual(isValidHexColor('#FFFFFF'), true);
  assert.strictEqual(isValidHexColor('#000000'), true);

  assert.strictEqual(isValidHexColor('1a2b3c'), false, 'missing #');
  assert.strictEqual(isValidHexColor('#abc'), false, 'shorthand not allowed');
  assert.strictEqual(isValidHexColor('#1a2b3g'), false, 'non-hex digit');
  assert.strictEqual(isValidHexColor('blue'), false);
  assert.strictEqual(isValidHexColor(0xffffff), false, 'non-string rejected');
  assert.strictEqual(isValidHexColor(null), false);
});
