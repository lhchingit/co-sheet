process.env.NODE_ENV = 'test';

/**
 * @file formula-criteria.test.js
 * @description The criterion language shared by COUNTIF/SUMIF(S)/AVERAGEIF/MAXIFS/
 * MINIFS and XLOOKUP's wildcard mode: comparison operators, numeric vs text
 * comparison, `*` and `?` wildcards, and `<>` negation.
 *
 * These had no coverage at all before #253 rewrote the matcher to compile a
 * criterion once per range instead of once per value, which is exactly the kind of
 * refactor that can quietly change an edge case. Every case here is a statement
 * about behaviour, not about the implementation: they pass identically against the
 * per-value matcher this replaced.
 *
 * Drives the engine directly (sheet-utils + formula-engine in a vm), with a cell
 * resolver standing in for the sheet. Follows the AAA pattern.
 */
import test from 'node:test';
import assert from 'node:assert';
import vm from 'vm';
import fs from 'fs';
import path from 'path';

/**
 * Load the formula engine over a sheet given as a plain map of coord -> stored text.
 * @param {Record<string, string>} cells
 * @returns {(formula: string) => string} evaluateFormula, bound to that sheet.
 */
function engineOver(cells) {
  const ctx = { console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['sheet-utils.js', 'formula-engine.js']) {
    vm.runInContext(fs.readFileSync(path.resolve('public', f), 'utf8'), ctx, { filename: f });
  }
  ctx.CoSheet.formula.setCellResolver((coord) => (coord in cells ? cells[coord] : ''));
  return (formula) => ctx.CoSheet.formula.evaluateFormula(formula);
}

/** A column of values at A1..An, and a parallel column at B1..Bn. */
function columns(a, b) {
  const cells = {};
  a.forEach((v, i) => { cells[`A${i + 1}`] = String(v); });
  (b || []).forEach((v, i) => { cells[`B${i + 1}`] = String(v); });
  return cells;
}

test('COUNTIF matches text exactly, and case-insensitively', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(['apple', 'Apple', 'APPLE', 'apricot', '']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"apple")'), '3', 'case is ignored');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"appl")'), '0', 'a prefix is not a match');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"APRICOT")'), '1');
});

test('COUNTIF honours the * and ? wildcards', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(['apple', 'apricot', 'banana', 'ape', 'grape']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"ap*")'), '3', '* matches any run');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"*ape")'), '2', 'including at the front');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"ap?")'), '1', '? matches exactly one character');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"*a*")'), '5');
});

test('regex metacharacters in a criterion are literal text, not pattern syntax', () => {
  // The matcher compiles the criterion into a RegExp, so anything it fails to escape
  // would silently become pattern syntax.
  // --- Arrange ---
  const evaluate = engineOver(columns(['a.c', 'abc', 'a+c', 'ac', 'a(c)', 'a|c']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A6,"a.c")'), '1', '. is a dot, not any-character');
  assert.strictEqual(evaluate('=COUNTIF(A1:A6,"a+c")'), '1', '+ is a plus, not a quantifier');
  assert.strictEqual(evaluate('=COUNTIF(A1:A6,"a(c)")'), '1', 'parentheses are literal');
  assert.strictEqual(evaluate('=COUNTIF(A1:A6,"a|c")'), '1', 'the pipe is literal');
});

test('COUNTIF compares numerically behind the comparison operators', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns([1, 5, 10, 20, 5]));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,">5")'), '2');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,">=5")'), '4');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"<5")'), '1');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"<=5")'), '3');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"=5")'), '2');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,"<>5")'), '3');
  assert.strictEqual(evaluate('=COUNTIF(A1:A5,5)'), '2', 'a bare number is an equality test');
});

test('a non-numeric value satisfies a numeric <> and fails every other comparison', () => {
  // The one asymmetry in the numeric path: a value that cannot be read as a number
  // is "not equal to 5", but it is not "less than 5" either.
  // --- Arrange ---
  const evaluate = engineOver(columns([1, 'text', 10, 'more text']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"<>5")'), '4', 'text counts as not-equal');
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"<5")'), '1', 'but never as less-than');
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,">5")'), '1');
});

test('a blank cell reads as zero in a numeric comparison', () => {
  // Not obviously right, but long-standing and depended upon: a blank is not
  // "unreadable as a number" the way text is, it is 0.
  // --- Arrange ---
  const evaluate = engineOver(columns([1, '', 10, '']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"<5")'), '3', 'the two blanks count as 0');
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"=0")'), '2');
});

test('<> negates a text criterion, wildcards included', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(['apple', 'apricot', 'banana', 'cherry']));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"<>apple")'), '3');
  assert.strictEqual(evaluate('=COUNTIF(A1:A4,"<>ap*")'), '2', 'the negation applies to the whole pattern');
});

test('SUMIF sums a separate range, and defaults to the criteria range', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns([1, 5, 10, 20], [100, 200, 300, 400]));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=SUMIF(A1:A4,">4",B1:B4)'), '900', 'sums the parallel range');
  assert.strictEqual(evaluate('=SUMIF(A1:A4,">4")'), '35', 'with no third argument, sums the tested range');
});

test('the *IFS forms require every criterion to hold on the same row', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(
    ['red', 'blue', 'red', 'blue', 'red'],
    [1, 2, 3, 4, 5]
  ));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIFS(A1:A5,"red",B1:B5,">2")'), '2', 'rows 3 and 5');
  assert.strictEqual(evaluate('=SUMIFS(B1:B5,A1:A5,"red",B1:B5,">2")'), '8');
  assert.strictEqual(evaluate('=MAXIFS(B1:B5,A1:A5,"red")'), '5');
  assert.strictEqual(evaluate('=MINIFS(B1:B5,A1:A5,"blue")'), '2');
  assert.strictEqual(evaluate('=AVERAGEIF(A1:A5,"blue",B1:B5)'), '3');
});

test('a criterion matching nothing gives each aggregate its own empty answer', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(['red', 'blue'], [1, 2]));

  // --- Act & Assert ---
  assert.strictEqual(evaluate('=COUNTIF(A1:A2,"green")'), '0');
  assert.strictEqual(evaluate('=SUMIF(A1:A2,"green",B1:B2)'), '0');
  assert.strictEqual(evaluate('=MAXIFS(B1:B2,A1:A2,"green")'), '0');
  assert.strictEqual(evaluate('=AVERAGEIF(A1:A2,"green",B1:B2)'), '#DIV/0!', 'an average of nothing is an error');
});

test('XLOOKUP match mode 2 searches with the same wildcard language', () => {
  // --- Arrange ---
  const evaluate = engineOver(columns(
    ['apple', 'apricot', 'banana'],
    ['first', 'second', 'third']
  ));

  // --- Act & Assert ---
  assert.strictEqual(
    evaluate('=XLOOKUP("apr*",A1:A3,B1:B3,"none",2)'), 'second',
    'the wildcard finds the first row it matches'
  );
  assert.strictEqual(
    evaluate('=XLOOKUP("ap*",A1:A3,B1:B3,"none",2)'), 'first',
    'and stops at the first, not the last'
  );
  assert.strictEqual(
    evaluate('=XLOOKUP("zz*",A1:A3,B1:B3,"none",2)'), 'none',
    'with the if-not-found value when nothing matches'
  );
});
