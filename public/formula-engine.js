// @ts-check
/**
 * @file formula-engine.js
 * @description Tokenizer + recursive-descent parser + evaluator + function
 * library for the spreadsheet formula language. Published on window.CoSheet.formula.
 * Pure except for cell-reference resolution, which the host app injects via
 * setCellResolver(fn) where fn(coord, depth) returns the raw stored cell text.
 * Depends on window.CoSheet.utils; load as a classic <script> after sheet-utils.js
 * and before app.js.
 */
(function () {
  const root = (typeof window !== 'undefined') ? window : globalThis;
  root.CoSheet = root.CoSheet || {};
  const { parseCoordinates, getColLetter } = root.CoSheet.utils;

  // Cell-reference accessor injected by the host (app.js) via setCellResolver().
  // The no-op default keeps the engine callable (refs read blank) before wiring.
  /** @type {(coord: string, depth?: number) => any} */
  let getCellValue = () => '';

/* =============================================================================
 * Formula engine
 * =============================================================================
 * A tokenizer + recursive-descent parser + evaluator that supports cell
 * references, ranges (A1:B2), the standard operators (+ - * / ^ & % and the
 * comparisons) and a library of spreadsheet functions (FORMULA_FUNCS below).
 *
 * Values flow through the evaluator as native JS types: number, string,
 * boolean, a "range" object ({ __range, values, r1, c1, r2, c2 }) and an
 * "error" object ({ __error: '#DIV/0!' }). Errors are values (not thrown), so
 * they propagate through operators and can be trapped by IFERROR/IFNA.
 * evaluateFormula() converts the final value back to a display string.
 * ========================================================================== */

const FORMULA_ERRORS = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!', '#ERR!'];
const mkErr = (code) => ({ __error: code });
/** @param {any} v @returns {v is { __error: any }} */
const isErr = (v) => !!(v && typeof v === 'object' && v.__error);
const isRange = (v) => !!(v && typeof v === 'object' && v.__range);
// Date value: behaves as its numeric serial everywhere (arithmetic, YEAR(),
// comparisons) but renders as a formatted date string. `time` adds H:MM:SS.
const mkDate = (serial, time = false) => ({ __date: true, serial, time });
const isDate = (v) => !!(v && typeof v === 'object' && v.__date);
const CELL_RE = /^[A-Z]+[0-9]+$/;
const DATE_STR_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}):(\d{2}))?$/;

/** Tokenizes a formula body (without the leading '='). */
const tokenizeFormula = (src) => {
  const tokens = [];
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '_' || c === '$';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '"') { // string literal, "" escapes a quote
      let s = ''; i++;
      while (i < n) {
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '"'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      tokens.push({ t: 'str', v: s }); continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i + 1;
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
      if (src[j] === 'e' || src[j] === 'E') { j++; if (src[j] === '+' || src[j] === '-') j++; while (j < n && isDigit(src[j])) j++; }
      tokens.push({ t: 'num', v: parseFloat(src.slice(i, j)) }); i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < n && (isAlpha(src[j]) || isDigit(src[j]) || src[j] === '.')) j++;
      tokens.push({ t: 'ident', v: src.slice(i, j) }); i = j; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>') { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&%=<>():,'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue; }
    throw mkErr('#ERROR!');
  }
  tokens.push({ t: 'eof' });
  return tokens;
};

/** Parses a token stream into an AST. Throws an error object on bad syntax. */
const parseFormula = (tokens) => {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => tokens[pos].t === 'op' && tokens[pos].v === v;
  const expect = (v) => { if (!isOp(v)) throw mkErr('#ERROR!'); pos++; };

  const parseExpr = () => parseCompare();
  const parseCompare = () => {
    let left = parseConcat();
    while (peek().t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) {
      const op = tokens[pos++].v; left = { type: 'binary', op, left, right: parseConcat() };
    }
    return left;
  };
  const parseConcat = () => {
    let left = parseAdd();
    while (isOp('&')) { pos++; left = { type: 'binary', op: '&', left, right: parseAdd() }; }
    return left;
  };
  const parseAdd = () => {
    let left = parseMul();
    while (peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = tokens[pos++].v; left = { type: 'binary', op, left, right: parseMul() };
    }
    return left;
  };
  const parseMul = () => {
    let left = parsePow();
    while (peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = tokens[pos++].v; left = { type: 'binary', op, left, right: parsePow() };
    }
    return left;
  };
  const parsePow = () => {
    const left = parseUnary();
    if (isOp('^')) { pos++; return { type: 'binary', op: '^', left, right: parsePow() }; } // right-assoc
    return left;
  };
  const parseUnary = () => {
    if (peek().t === 'op' && (peek().v === '-' || peek().v === '+')) {
      const op = tokens[pos++].v; return { type: 'unary', op, operand: parseUnary() };
    }
    return parsePostfix();
  };
  const parsePostfix = () => {
    let node = parsePrimary();
    while (isOp('%')) { pos++; node = { type: 'percent', operand: node }; }
    return node;
  };
  const parsePrimary = () => {
    const tk = peek();
    if (tk.t === 'num') { pos++; return { type: 'num', value: tk.v }; }
    if (tk.t === 'str') { pos++; return { type: 'str', value: tk.v }; }
    if (tk.t === 'op' && tk.v === '(') { pos++; const e = parseExpr(); expect(')'); return e; }
    if (tk.t === 'ident') {
      pos++;
      if (isOp('(')) { // function call
        pos++;
        const args = [];
        if (!isOp(')')) {
          args.push(parseExpr());
          while (isOp(',')) { pos++; args.push(parseExpr()); }
        }
        expect(')');
        return { type: 'call', name: tk.v.toUpperCase(), args };
      }
      const up = tk.v.toUpperCase().replace(/\$/g, '');
      if (up === 'TRUE') return { type: 'bool', value: true };
      if (up === 'FALSE') return { type: 'bool', value: false };
      if (isOp(':')) { // range
        pos++;
        const tk2 = peek();
        if (tk2.t !== 'ident') throw mkErr('#REF!');
        pos++;
        return { type: 'range', from: up, to: tk2.v.toUpperCase().replace(/\$/g, '') };
      }
      return { type: 'ref', ref: up };
    }
    throw mkErr('#ERROR!');
  };

  const ast = parseExpr();
  if (peek().t !== 'eof') throw mkErr('#ERROR!');
  return ast;
};

/** Coerces a raw stored cell value (always a string) into a typed value. */
const coerceRaw = (raw) => {
  if (raw === '' || raw == null) return '';
  if (typeof raw !== 'string') raw = String(raw);
  if (raw[0] === '#' && FORMULA_ERRORS.includes(raw)) return mkErr(raw);
  const up = raw.toUpperCase();
  if (up === 'TRUE') return true;
  if (up === 'FALSE') return false;
  const trimmed = raw.trim();
  if (trimmed !== '' && !isNaN(trimmed) && isFinite(trimmed)) return parseFloat(trimmed);
  // Recognize a date string (the format the engine itself emits, e.g.
  // "2026/6/13" or "2026/6/13 14:30:00") so a referenced date cell stays a date.
  const dm = trimmed.match(DATE_STR_RE);
  if (dm) {
    const hasTime = dm[4] !== undefined;
    return mkDate(dateToSerial(+dm[1], +dm[2], +dm[3], +(dm[4] || 0), +(dm[5] || 0), +(dm[6] || 0)), hasTime);
  }
  return raw;
};

/** Resolves a cell reference (e.g. "A1") to a typed value. */
const refToValue = (ref, ctx) => {
  if (!CELL_RE.test(ref)) return mkErr('#NAME?');
  return coerceRaw(getCellValue(ref, ctx.depth + 1));
};

/** Builds a range value object from a range AST node. */
const evalRange = (node, ctx) => {
  if (!CELL_RE.test(node.from) || !CELL_RE.test(node.to)) return mkErr('#REF!');
  const a = parseCoordinates(node.from);
  const b = parseCoordinates(node.to);
  const r1 = Math.min(a.row, b.row), r2 = Math.max(a.row, b.row);
  const c1 = Math.min(a.col, b.col), c2 = Math.max(a.col, b.col);
  const values = [];
  for (let r = r1; r <= r2; r++) {
    const row = [];
    for (let c = c1; c <= c2; c++) row.push(coerceRaw(getCellValue(`${getColLetter(c)}${r + 1}`, ctx.depth + 1)));
    values.push(row);
  }
  return { __range: true, values, r1, c1, r2, c2 };
};

/** Reduces a range to a scalar (1x1 -> its value, otherwise #VALUE!). */
const scalarize = (v) => {
  if (isRange(v)) {
    if (v.values.length === 1 && v.values[0].length === 1) return v.values[0][0];
    return mkErr('#VALUE!');
  }
  return v;
};

const flattenRange = (rng) => { const out = []; for (const row of rng.values) for (const c of row) out.push(c); return out; };

/** Coerces a scalar value to a number, or returns an error value. */
const toNum = (v) => {
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (isDate(v)) return v.serial;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === '') return 0;
  if (isRange(v)) return toNum(scalarize(v));
  if (typeof v === 'string') { const t = v.trim(); if (t !== '' && !isNaN(Number(t)) && isFinite(Number(t))) return parseFloat(t); return mkErr('#VALUE!'); }
  return mkErr('#VALUE!');
};

/** Coerces a scalar value to a boolean, or returns an error value. */
const toBool = (v) => {
  if (isErr(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (isDate(v)) return v.serial !== 0;
  if (isRange(v)) return toBool(scalarize(v));
  if (typeof v === 'string') { const u = v.toUpperCase(); if (u === 'TRUE') return true; if (u === 'FALSE') return false; const t = v.trim(); if (t !== '' && !isNaN(Number(t))) return parseFloat(t) !== 0; }
  return mkErr('#VALUE!');
};

/** Formats a finite number for display, trimming binary-float noise. */
const formatNum = (n) => {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
};

/** Formats a date serial as "YYYY/M/D" (optionally with " H:MM:SS"). */
const formatDate = (serial, withTime) => {
  const d = serialToDate(serial);
  const p2 = (x) => String(x).padStart(2, '0');
  let s = `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  if (withTime) s += ` ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  return s;
};

/** Formats a scalar value for display. */
const formatScalar = (v) => {
  if (isErr(v)) return v.__error;
  if (v === '' || v == null) return '';
  if (isDate(v)) return formatDate(v.serial, v.time);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') { if (isNaN(v) || !isFinite(v)) return '#NUM!'; return formatNum(v); }
  return String(v);
};

/** Concatenation / general string coercion for a scalar value. */
const toStr = (v) => formatScalar(scalarize(v));

/** Compares two scalar values per spreadsheet rules; returns boolean/error. */
const compareValues = (op, l, r) => {
  let res;
  if (isDate(l)) l = l.serial;
  if (isDate(r)) r = r.serial;
  if (typeof l === 'number' && typeof r === 'number') res = l < r ? -1 : (l > r ? 1 : 0);
  else if (typeof l === 'boolean' && typeof r === 'boolean') { const a = l ? 1 : 0, b = r ? 1 : 0; res = a < b ? -1 : (a > b ? 1 : 0); }
  else { const a = formatScalar(l).toUpperCase(), b = formatScalar(r).toUpperCase(); res = a < b ? -1 : (a > b ? 1 : 0); }
  switch (op) {
    case '=': return res === 0;
    case '<>': return res !== 0;
    case '<': return res < 0;
    case '>': return res > 0;
    case '<=': return res <= 0;
    case '>=': return res >= 0;
  }
  return mkErr('#ERROR!');
};

/** Evaluates a binary-operator AST node. */
const evalBinary = (node, ctx) => {
  let l = scalarize(evalNode(node.left, ctx));
  if (isErr(l)) return l;
  let r = scalarize(evalNode(node.right, ctx));
  if (isErr(r)) return r;
  const op = node.op;
  if (op === '&') return toStr(l) + toStr(r);
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compareValues(op, l, r);
  const a = toNum(l); if (isErr(a)) return a;
  const b = toNum(r); if (isErr(b)) return b;
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? mkErr('#DIV/0!') : a / b;
    case '^': return Math.pow(a, b);
  }
  return mkErr('#ERROR!');
};

/** Core AST evaluator. Returns a typed value (never throws for cell errors). */
const evalNode = (node, ctx) => {
  switch (node.type) {
    case 'num': return node.value;
    case 'str': return node.value;
    case 'bool': return node.value;
    case 'ref': return refToValue(node.ref, ctx);
    case 'range': return evalRange(node, ctx);
    case 'unary': { const v = toNum(scalarize(evalNode(node.operand, ctx))); if (isErr(v)) return v; return node.op === '-' ? -v : v; }
    case 'percent': { const v = toNum(scalarize(evalNode(node.operand, ctx))); if (isErr(v)) return v; return v / 100; }
    case 'binary': return evalBinary(node, ctx);
    case 'call': return evalCall(node, ctx);
  }
  return mkErr('#ERROR!');
};

/** Dispatches a function call to the FORMULA_FUNCS library. */
const evalCall = (node, ctx) => {
  const fn = FORMULA_FUNCS[node.name];
  if (!fn) return mkErr('#NAME?');
  try { return fn(node.args, ctx); }
  catch (e) { return isErr(e) ? e : mkErr('#ERROR!'); }
};

// --- argument helpers (throw error objects, caught by evalCall) -------------
const evAt = (args, ctx, i) => { const v = scalarize(evalNode(args[i], ctx)); if (isErr(v)) throw v; return v; };
const valAt = (args, ctx, i) => { const v = evalNode(args[i], ctx); if (isErr(v)) throw v; return v; };
const numAt = (args, ctx, i) => { const v = toNum(evAt(args, ctx, i)); if (isErr(v)) throw v; return v; };
const optNumAt = (args, ctx, i, def) => (i < args.length ? numAt(args, ctx, i) : def);
const strAt = (args, ctx, i) => toStr(evAt(args, ctx, i));
const boolAt = (args, ctx, i) => { const v = toBool(evAt(args, ctx, i)); if (isErr(v)) throw v; return v; };
const rangeAt = (args, ctx, i) => {
  const v = evalNode(args[i], ctx); if (isErr(v)) throw v;
  if (isRange(v)) return v;
  return { __range: true, values: [[v]], r1: 0, c1: 0, r2: 0, c2: 0 };
};
/** Expands args (ranges flattened) into a flat list of values; errors throw. */
const collectValues = (args, ctx) => {
  const out = [];
  for (const a of args) {
    const v = evalNode(a, ctx);
    if (isErr(v)) throw v;
    if (isRange(v)) for (const c of flattenRange(v)) { if (isErr(c)) throw c; out.push(c); }
    else out.push(v);
  }
  return out;
};
/** Like collectValues but keeps only numeric values (numbers, numeric text, booleans). */
const collectNumbers = (args, ctx) => {
  const nums = [];
  for (const v of collectValues(args, ctx)) {
    if (typeof v === 'number') nums.push(v);
    else if (isDate(v)) nums.push(v.serial);
    else if (typeof v === 'boolean') nums.push(v ? 1 : 0);
    else if (typeof v === 'string') { const t = v.trim(); if (t !== '' && !isNaN(Number(t)) && isFinite(Number(t))) nums.push(parseFloat(t)); }
  }
  return nums;
};

/** Tests a single value against a criterion (number, "=x", ">5", text, wildcards). */
const matchCriteria = (value, criterion) => {
  if (typeof criterion === 'number') { const n = toNum(value); return !isErr(n) && n === criterion; }
  if (typeof criterion === 'boolean') return value === criterion;
  let crit = String(criterion);
  let op = '=';
  const m = crit.match(/^(<=|>=|<>|=|<|>)/);
  if (m) { op = m[1]; crit = crit.slice(m[1].length); }
  const critNum = (crit.trim() !== '' && !isNaN(Number(crit)) && isFinite(Number(crit))) ? parseFloat(crit) : null;
  if (critNum !== null && (op === '<' || op === '>' || op === '<=' || op === '>=' || op === '=' || op === '<>')) {
    const n = toNum(value);
    if (isErr(n)) return op === '<>';
    switch (op) { case '=': return n === critNum; case '<>': return n !== critNum; case '<': return n < critNum; case '>': return n > critNum; case '<=': return n <= critNum; case '>=': return n >= critNum; }
  }
  // text comparison with * and ? wildcards (case-insensitive)
  const valStr = formatScalar(value).toUpperCase();
  const pat = crit.toUpperCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  const re = new RegExp(`^${pat}$`);
  const matched = re.test(valStr);
  return op === '<>' ? !matched : matched;
};

// --- date helpers (serial = days since 1899-12-30, matching Sheets) ---------
const DATE_EPOCH = Date.UTC(1899, 11, 30);
const dateToSerial = (y, mo, d, hh = 0, mi = 0, ss = 0) => (Date.UTC(y, mo - 1, d, hh, mi, ss) - DATE_EPOCH) / 86400000;
const serialToDate = (s) => new Date(DATE_EPOCH + Math.round(s * 86400000));

/** The spreadsheet function library. Each fn receives (argNodes, ctx). */
const FORMULA_FUNCS = {
  // --- Math ---------------------------------------------------------------
  ABS: (a, c) => Math.abs(numAt(a, c, 0)),
  ACOS: (a, c) => Math.acos(numAt(a, c, 0)),
  ACOSH: (a, c) => Math.acosh(numAt(a, c, 0)),
  ASIN: (a, c) => Math.asin(numAt(a, c, 0)),
  ASINH: (a, c) => Math.asinh(numAt(a, c, 0)),
  ATAN: (a, c) => Math.atan(numAt(a, c, 0)),
  ATAN2: (a, c) => Math.atan2(numAt(a, c, 1), numAt(a, c, 0)),
  ATANH: (a, c) => Math.atanh(numAt(a, c, 0)),
  COS: (a, c) => Math.cos(numAt(a, c, 0)),
  COSH: (a, c) => Math.cosh(numAt(a, c, 0)),
  SIN: (a, c) => Math.sin(numAt(a, c, 0)),
  SINH: (a, c) => Math.sinh(numAt(a, c, 0)),
  TAN: (a, c) => Math.tan(numAt(a, c, 0)),
  TANH: (a, c) => Math.tanh(numAt(a, c, 0)),
  DEGREES: (a, c) => numAt(a, c, 0) * 180 / Math.PI,
  RADIANS: (a, c) => numAt(a, c, 0) * Math.PI / 180,
  PI: () => Math.PI,
  EXP: (a, c) => Math.exp(numAt(a, c, 0)),
  LN: (a, c) => { const n = numAt(a, c, 0); return n <= 0 ? mkErr('#NUM!') : Math.log(n); },
  LOG10: (a, c) => { const n = numAt(a, c, 0); return n <= 0 ? mkErr('#NUM!') : Math.log10(n); },
  LOG: (a, c) => { const n = numAt(a, c, 0), b = optNumAt(a, c, 1, 10); return n <= 0 || b <= 0 ? mkErr('#NUM!') : Math.log(n) / Math.log(b); },
  SQRT: (a, c) => { const n = numAt(a, c, 0); return n < 0 ? mkErr('#NUM!') : Math.sqrt(n); },
  POWER: (a, c) => Math.pow(numAt(a, c, 0), numAt(a, c, 1)),
  SIGN: (a, c) => Math.sign(numAt(a, c, 0)),
  INT: (a, c) => Math.floor(numAt(a, c, 0)),
  MOD: (a, c) => { const x = numAt(a, c, 0), y = numAt(a, c, 1); return y === 0 ? mkErr('#DIV/0!') : x - y * Math.floor(x / y); },
  QUOTIENT: (a, c) => { const y = numAt(a, c, 1); return y === 0 ? mkErr('#DIV/0!') : Math.trunc(numAt(a, c, 0) / y); },
  FACT: (a, c) => { let n = Math.floor(numAt(a, c, 0)); if (n < 0) return mkErr('#NUM!'); let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; },
  GCD: (a, c) => { const ns = collectNumbers(a, c).map(Math.abs).map(Math.floor); const g = (x, y) => y ? g(y, x % y) : x; return ns.reduce((x, y) => g(x, y), 0); },
  LCM: (a, c) => { const ns = collectNumbers(a, c).map(Math.abs).map(Math.floor); const g = (x, y) => y ? g(y, x % y) : x; return ns.reduce((x, y) => (x && y) ? x / g(x, y) * y : 0); },
  CEILING: (a, c) => { const n = numAt(a, c, 0), f = optNumAt(a, c, 1, 1); return f === 0 ? 0 : Math.ceil(n / f) * f; },
  FLOOR: (a, c) => { const n = numAt(a, c, 0), f = optNumAt(a, c, 1, 1); return f === 0 ? 0 : Math.floor(n / f) * f; },
  MROUND: (a, c) => { const n = numAt(a, c, 0), f = numAt(a, c, 1); return f === 0 ? 0 : Math.round(n / f) * f; },
  ROUND: (a, c) => { const f = Math.pow(10, optNumAt(a, c, 1, 0)); return Math.round(numAt(a, c, 0) * f) / f; },
  ROUNDUP: (a, c) => { const f = Math.pow(10, optNumAt(a, c, 1, 0)); const n = numAt(a, c, 0); return (n < 0 ? -Math.ceil(-n * f) : Math.ceil(n * f)) / f; },
  ROUNDDOWN: (a, c) => { const f = Math.pow(10, optNumAt(a, c, 1, 0)); const n = numAt(a, c, 0); return (n < 0 ? -Math.floor(-n * f) : Math.floor(n * f)) / f; },
  TRUNC: (a, c) => { const f = Math.pow(10, optNumAt(a, c, 1, 0)); const n = numAt(a, c, 0); return Math.trunc(n * f) / f; },
  RAND: () => Math.random(),
  RANDBETWEEN: (a, c) => { const lo = Math.ceil(numAt(a, c, 0)), hi = Math.floor(numAt(a, c, 1)); return Math.floor(Math.random() * (hi - lo + 1)) + lo; },
  SUM: (a, c) => collectNumbers(a, c).reduce((s, n) => s + n, 0),
  SUMSQ: (a, c) => collectNumbers(a, c).reduce((s, n) => s + n * n, 0),
  PRODUCT: (a, c) => { const ns = collectNumbers(a, c); return ns.length ? ns.reduce((p, n) => p * n, 1) : 0; },
  SUMPRODUCT: (a, c) => {
    const ranges = a.map(node => rangeAt([node], c, 0));
    const lens = ranges.map(r => flattenRange(r).length);
    const len = Math.max(...lens);
    let total = 0;
    for (let i = 0; i < len; i++) {
      let prod = 1;
      for (const r of ranges) { const f = flattenRange(r); const n = toNum(f[i] === undefined ? 0 : f[i]); prod *= isErr(n) ? 0 : n; }
      total += prod;
    }
    return total;
  },
  SUMIF: (a, c) => conditionalAggregate(a, c, 'sum', false),
  SUMIFS: (a, c) => conditionalAggregate(a, c, 'sum', true),
  COUNTIF: (a, c) => conditionalAggregate(a, c, 'count', false),
  COUNTIFS: (a, c) => conditionalAggregate(a, c, 'count', true),
  AVERAGEIF: (a, c) => conditionalAggregate(a, c, 'avg', false),
  AVERAGEIFS: (a, c) => conditionalAggregate(a, c, 'avg', true),
  MAXIFS: (a, c) => conditionalAggregate(a, c, 'max', true),
  MINIFS: (a, c) => conditionalAggregate(a, c, 'min', true),
  COUNTBLANK: (a, c) => flattenRange(rangeAt(a, c, 0)).filter(v => v === '' || v == null).length,

  // --- Statistical --------------------------------------------------------
  AVERAGE: (a, c) => { const ns = collectNumbers(a, c); return ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : mkErr('#DIV/0!'); },
  AVERAGEA: (a, c) => { const vs = collectValues(a, c).filter(v => v !== ''); if (!vs.length) return mkErr('#DIV/0!'); const ns = vs.map(v => typeof v === 'number' ? v : (typeof v === 'boolean' ? (v ? 1 : 0) : (isNaN(v) ? 0 : parseFloat(v)))); return ns.reduce((s, n) => s + n, 0) / ns.length; },
  COUNT: (a, c) => collectNumbers(a, c).length,
  COUNTA: (a, c) => collectValues(a, c).filter(v => v !== '' && v != null).length,
  MAX: (a, c) => { const ns = collectNumbers(a, c); return ns.length ? Math.max(...ns) : 0; },
  MIN: (a, c) => { const ns = collectNumbers(a, c); return ns.length ? Math.min(...ns) : 0; },
  MEDIAN: (a, c) => { const ns = collectNumbers(a, c).sort((x, y) => x - y); if (!ns.length) return mkErr('#NUM!'); const m = Math.floor(ns.length / 2); return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2; },
  MODE: (a, c) => { const ns = collectNumbers(a, c); const cnt = {}; let best = null, bestC = 0; for (const n of ns) { cnt[n] = (cnt[n] || 0) + 1; if (cnt[n] > bestC) { bestC = cnt[n]; best = n; } } return bestC > 1 ? best : mkErr('#N/A'); },
  LARGE: (a, c) => { const ns = collectNumbers([a[0]], c).sort((x, y) => y - x); const k = numAt(a, c, 1); return (k >= 1 && k <= ns.length) ? ns[k - 1] : mkErr('#NUM!'); },
  SMALL: (a, c) => { const ns = collectNumbers([a[0]], c).sort((x, y) => x - y); const k = numAt(a, c, 1); return (k >= 1 && k <= ns.length) ? ns[k - 1] : mkErr('#NUM!'); },
  STDEV: (a, c) => stdev(collectNumbers(a, c), true),
  STDEVP: (a, c) => stdev(collectNumbers(a, c), false),
  VAR: (a, c) => variance(collectNumbers(a, c), true),
  VARP: (a, c) => variance(collectNumbers(a, c), false),
  RANK: (a, c) => { const x = numAt(a, c, 0); const ns = collectNumbers([a[1]], c); const asc = a.length > 2 ? boolAt(a, c, 2) : false; const sorted = ns.slice().sort((p, q) => asc ? p - q : q - p); const idx = sorted.indexOf(x); return idx < 0 ? mkErr('#N/A') : idx + 1; },
  PERCENTILE: (a, c) => { const ns = collectNumbers([a[0]], c).sort((x, y) => x - y); const p = numAt(a, c, 1); if (!ns.length || p < 0 || p > 1) return mkErr('#NUM!'); const idx = p * (ns.length - 1); const lo = Math.floor(idx); return ns[lo] + (idx - lo) * ((ns[lo + 1] ?? ns[lo]) - ns[lo]); },
  QUARTILE: (a, c) => FORMULA_FUNCS.PERCENTILE([a[0], { type: 'num', value: (numAt(a, c, 1)) / 4 }], c),
  CORREL: (a, c) => { const x = collectNumbers([a[0]], c), y = collectNumbers([a[1]], c); const n = Math.min(x.length, y.length); if (!n) return mkErr('#DIV/0!'); const mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : mkErr('#DIV/0!'); },

  // --- Logical ------------------------------------------------------------
  TRUE: () => true,
  FALSE: () => false,
  NOT: (a, c) => { const b = toBool(evAt(a, c, 0)); return isErr(b) ? b : !b; },
  AND: (a, c) => { const vs = collectValues(a, c).filter(v => typeof v === 'boolean' || typeof v === 'number'); if (!vs.length) return mkErr('#VALUE!'); return vs.every(v => (typeof v === 'boolean' ? v : v !== 0)); },
  OR: (a, c) => { const vs = collectValues(a, c).filter(v => typeof v === 'boolean' || typeof v === 'number'); if (!vs.length) return mkErr('#VALUE!'); return vs.some(v => (typeof v === 'boolean' ? v : v !== 0)); },
  XOR: (a, c) => { const vs = collectValues(a, c).filter(v => typeof v === 'boolean' || typeof v === 'number'); const t = vs.filter(v => (typeof v === 'boolean' ? v : v !== 0)).length; return t % 2 === 1; },
  IF: (a, c) => { const cond = toBool(evAt(a, c, 0)); if (isErr(cond)) return cond; if (cond) return valAt(a, c, 1); return a.length > 2 ? valAt(a, c, 2) : false; },
  IFERROR: (a, c) => { const v = evalNode(a[0], c); if (isErr(v)) return a.length > 1 ? valAt(a, c, 1) : ''; return v; },
  IFNA: (a, c) => { const v = evalNode(a[0], c); if (isErr(v) && v.__error === '#N/A') return a.length > 1 ? valAt(a, c, 1) : ''; return v; },
  IFS: (a, c) => { for (let i = 0; i + 1 < a.length; i += 2) { const cond = toBool(evAt(a, c, i)); if (isErr(cond)) return cond; if (cond) return valAt(a, c, i + 1); } return mkErr('#N/A'); },
  SWITCH: (a, c) => { const key = evAt(a, c, 0); let i = 1; for (; i + 1 < a.length; i += 2) { const cmp = evAt(a, c, i); if (compareValues('=', key, cmp) === true) return valAt(a, c, i + 1); } return i < a.length ? valAt(a, c, i) : mkErr('#N/A'); },

  // --- Information --------------------------------------------------------
  ISBLANK: (a, c) => evalNode(a[0], c) === '',
  ISNUMBER: (a, c) => { const v = scalarize(evalNode(a[0], c)); return typeof v === 'number' || isDate(v); },
  ISTEXT: (a, c) => typeof scalarize(evalNode(a[0], c)) === 'string' && scalarize(evalNode(a[0], c)) !== '',
  ISLOGICAL: (a, c) => typeof scalarize(evalNode(a[0], c)) === 'boolean',
  ISERROR: (a, c) => isErr(evalNode(a[0], c)),
  ISERR: (a, c) => { const v = evalNode(a[0], c); return isErr(v) && v.__error !== '#N/A'; },
  ISNA: (a, c) => { const v = evalNode(a[0], c); return isErr(v) && v.__error === '#N/A'; },
  NA: () => mkErr('#N/A'),

  // --- Text ---------------------------------------------------------------
  LEN: (a, c) => strAt(a, c, 0).length,
  LEFT: (a, c) => strAt(a, c, 0).slice(0, optNumAt(a, c, 1, 1)),
  RIGHT: (a, c) => { const s = strAt(a, c, 0), n = optNumAt(a, c, 1, 1); return n <= 0 ? '' : s.slice(Math.max(0, s.length - n)); },
  MID: (a, c) => { const s = strAt(a, c, 0), start = numAt(a, c, 1), len = numAt(a, c, 2); return start < 1 ? mkErr('#VALUE!') : s.substr(start - 1, len); },
  UPPER: (a, c) => strAt(a, c, 0).toUpperCase(),
  LOWER: (a, c) => strAt(a, c, 0).toLowerCase(),
  PROPER: (a, c) => strAt(a, c, 0).replace(/\b\w/g, ch => ch.toUpperCase()).replace(/\B\w/g, ch => ch.toLowerCase()),
  TRIM: (a, c) => strAt(a, c, 0).replace(/\s+/g, ' ').trim(),
  CLEAN: (a, c) => strAt(a, c, 0).replace(/[\x00-\x1F]/g, ''),
  CHAR: (a, c) => String.fromCharCode(numAt(a, c, 0)),
  CODE: (a, c) => { const s = strAt(a, c, 0); return s.length ? s.charCodeAt(0) : mkErr('#VALUE!'); },
  REPT: (a, c) => { const n = numAt(a, c, 1); return n < 0 ? mkErr('#VALUE!') : strAt(a, c, 0).repeat(n); },
  EXACT: (a, c) => strAt(a, c, 0) === strAt(a, c, 1),
  CONCATENATE: (a, c) => collectValues(a, c).map(formatScalar).join(''),
  TEXTJOIN: (a, c) => { const delim = strAt(a, c, 0); const skip = boolAt(a, c, 1); const vals = collectValues(a.slice(2), c).map(formatScalar); return (skip ? vals.filter(v => v !== '') : vals).join(delim); },
  FIND: (a, c) => { const idx = strAt(a, c, 1).indexOf(strAt(a, c, 0), optNumAt(a, c, 2, 1) - 1); return idx < 0 ? mkErr('#VALUE!') : idx + 1; },
  SEARCH: (a, c) => { const idx = strAt(a, c, 1).toUpperCase().indexOf(strAt(a, c, 0).toUpperCase(), optNumAt(a, c, 2, 1) - 1); return idx < 0 ? mkErr('#VALUE!') : idx + 1; },
  SUBSTITUTE: (a, c) => { const s = strAt(a, c, 0), find = strAt(a, c, 1), repl = strAt(a, c, 2); if (find === '') return s; if (a.length > 3) { const which = numAt(a, c, 3); let count = 0, idx = -1; while ((idx = s.indexOf(find, idx + 1)) >= 0) { if (++count === which) return s.slice(0, idx) + repl + s.slice(idx + find.length); } return s; } return s.split(find).join(repl); },
  REPLACE: (a, c) => { const s = strAt(a, c, 0), start = numAt(a, c, 1), len = numAt(a, c, 2), repl = strAt(a, c, 3); return s.slice(0, start - 1) + repl + s.slice(start - 1 + len); },
  VALUE: (a, c) => { const v = toNum(evAt(a, c, 0)); return v; },
  TEXT: (a, c) => formatWithPattern(numAt(a, c, 0), strAt(a, c, 1)),
  REGEXMATCH: (a, c) => { try { return new RegExp(strAt(a, c, 1)).test(strAt(a, c, 0)); } catch (e) { return mkErr('#VALUE!'); } },
  REGEXEXTRACT: (a, c) => { try { const m = strAt(a, c, 0).match(new RegExp(strAt(a, c, 1))); return m ? (m[1] !== undefined ? m[1] : m[0]) : mkErr('#N/A'); } catch (e) { return mkErr('#VALUE!'); } },
  REGEXREPLACE: (a, c) => { try { return strAt(a, c, 0).replace(new RegExp(strAt(a, c, 1), 'g'), strAt(a, c, 2)); } catch (e) { return mkErr('#VALUE!'); } },
  SPLIT: (a, c) => { const delim = strAt(a, c, 1) || ' '; const parts = strAt(a, c, 0).split(new RegExp('[' + delim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ']')).filter(p => p !== ''); return { __range: true, values: [parts], r1: 0, c1: 0, r2: 0, c2: parts.length - 1 }; },

  // --- Date & Time --------------------------------------------------------
  DATE: (a, c) => mkDate(dateToSerial(numAt(a, c, 0), numAt(a, c, 1), numAt(a, c, 2))),
  TODAY: () => { const d = new Date(); return mkDate(dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate())); },
  NOW: () => { const d = new Date(); return mkDate(dateToSerial(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()), true); },
  YEAR: (a, c) => serialToDate(numAt(a, c, 0)).getUTCFullYear(),
  MONTH: (a, c) => serialToDate(numAt(a, c, 0)).getUTCMonth() + 1,
  DAY: (a, c) => serialToDate(numAt(a, c, 0)).getUTCDate(),
  HOUR: (a, c) => serialToDate(numAt(a, c, 0)).getUTCHours(),
  MINUTE: (a, c) => serialToDate(numAt(a, c, 0)).getUTCMinutes(),
  SECOND: (a, c) => serialToDate(numAt(a, c, 0)).getUTCSeconds(),
  TIME: (a, c) => (numAt(a, c, 0) * 3600 + numAt(a, c, 1) * 60 + numAt(a, c, 2)) / 86400,
  WEEKDAY: (a, c) => { const d = serialToDate(numAt(a, c, 0)).getUTCDay(); const type = optNumAt(a, c, 1, 1); if (type === 2) return d === 0 ? 7 : d; if (type === 3) return (d + 6) % 7; return d + 1; },
  WEEKNUM: (a, c) => { const dt = serialToDate(numAt(a, c, 0)); const start = Date.UTC(dt.getUTCFullYear(), 0, 1); const days = Math.floor((dt.getTime() - start) / 86400000); return Math.floor((days + new Date(start).getUTCDay()) / 7) + 1; },
  DAYS: (a, c) => Math.round(numAt(a, c, 0) - numAt(a, c, 1)),
  DATEVALUE: (a, c) => { const t = Date.parse(strAt(a, c, 0)); return isNaN(t) ? mkErr('#VALUE!') : mkDate(Math.round((t - DATE_EPOCH) / 86400000)); },
  EDATE: (a, c) => { const d = serialToDate(numAt(a, c, 0)); return mkDate(dateToSerial(d.getUTCFullYear(), d.getUTCMonth() + 1 + numAt(a, c, 1), d.getUTCDate())); },
  EOMONTH: (a, c) => { const d = serialToDate(numAt(a, c, 0)); return mkDate(dateToSerial(d.getUTCFullYear(), d.getUTCMonth() + 2 + numAt(a, c, 1), 0)); },
  YEARFRAC: (a, c) => Math.abs(numAt(a, c, 0) - numAt(a, c, 1)) / 365,
  DATEDIF: (a, c) => { const s = serialToDate(numAt(a, c, 0)), e = serialToDate(numAt(a, c, 1)); const unit = strAt(a, c, 2).toUpperCase(); const days = Math.round((e.getTime() - s.getTime()) / 86400000); if (unit === 'D') return days; if (unit === 'M') return (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) - (e.getUTCDate() < s.getUTCDate() ? 1 : 0); if (unit === 'Y') { let y = e.getUTCFullYear() - s.getUTCFullYear(); if (e.getUTCMonth() < s.getUTCMonth() || (e.getUTCMonth() === s.getUTCMonth() && e.getUTCDate() < s.getUTCDate())) y--; return y; } return mkErr('#NUM!'); },
  WORKDAY: (a, c) => { let serial = Math.floor(numAt(a, c, 0)); let n = Math.floor(numAt(a, c, 1)); const step = n < 0 ? -1 : 1; n = Math.abs(n); while (n > 0) { serial += step; const dow = serialToDate(serial).getUTCDay(); if (dow !== 0 && dow !== 6) n--; } return mkDate(serial); },

  // --- Lookup -------------------------------------------------------------
  ROWS: (a, c) => { const r = rangeAt(a, c, 0); return r.r2 - r.r1 + 1; },
  COLUMNS: (a, c) => { const r = rangeAt(a, c, 0); return r.c2 - r.c1 + 1; },
  ROW: (a, c) => { if (!a.length) return c.owner && CELL_RE.test(c.owner) ? parseCoordinates(c.owner).row + 1 : mkErr('#REF!'); const node = a[0]; if (node.type === 'ref' && CELL_RE.test(node.ref)) return parseCoordinates(node.ref).row + 1; if (node.type === 'range') { const r = evalRange(node, c); return isErr(r) ? r : r.r1 + 1; } return mkErr('#VALUE!'); },
  COLUMN: (a, c) => { if (!a.length) return c.owner && CELL_RE.test(c.owner) ? parseCoordinates(c.owner).col + 1 : mkErr('#REF!'); const node = a[0]; if (node.type === 'ref' && CELL_RE.test(node.ref)) return parseCoordinates(node.ref).col + 1; if (node.type === 'range') { const r = evalRange(node, c); return isErr(r) ? r : r.c1 + 1; } return mkErr('#VALUE!'); },
  CHOOSE: (a, c) => { const idx = numAt(a, c, 0); return (idx >= 1 && idx < a.length) ? valAt(a, c, idx) : mkErr('#VALUE!'); },
  ADDRESS: (a, c) => { const row = numAt(a, c, 0), col = numAt(a, c, 1); return `$${getColLetter(col - 1)}$${row}`; },
  HYPERLINK: (a, c) => a.length > 1 ? strAt(a, c, 1) : strAt(a, c, 0),
  INDEX: (a, c) => { const r = rangeAt(a, c, 0); const ri = optNumAt(a, c, 1, 1), ci = optNumAt(a, c, 2, 1); const rows = r.values.length, cols = r.values[0] ? r.values[0].length : 0; const rr = ri === 0 ? 1 : ri, cc = ci === 0 ? 1 : ci; if (rr < 1 || rr > rows || cc < 1 || cc > cols) return mkErr('#REF!'); return r.values[rr - 1][cc - 1]; },
  MATCH: (a, c) => { const key = evAt(a, c, 0); const r = rangeAt(a, c, 1); const type = optNumAt(a, c, 2, 1); const flat = flattenRange(r); if (type === 0) { for (let i = 0; i < flat.length; i++) if (compareValues('=', flat[i], key) === true) return i + 1; return mkErr('#N/A'); } let best = -1; for (let i = 0; i < flat.length; i++) { const cmp = compareValues(type === 1 ? '<=' : '>=', flat[i], key); if (cmp === true) best = i; } return best < 0 ? mkErr('#N/A') : best + 1; },
  VLOOKUP: (a, c) => lookupVH(a, c, true),
  HLOOKUP: (a, c) => lookupVH(a, c, false),
  LOOKUP: (a, c) => { const key = evAt(a, c, 0); const r = rangeAt(a, c, 1); const flat = flattenRange(r); let best = -1; for (let i = 0; i < flat.length; i++) if (compareValues('<=', flat[i], key) === true) best = i; if (best < 0) return mkErr('#N/A'); if (a.length > 2) { const res = flattenRange(rangeAt(a, c, 2)); return res[best] ?? mkErr('#N/A'); } return flat[best]; },

  // --- Array (single-cell model: results render as a comma-joined list) ----
  ARRAYFORMULA: (a, c) => evalNode(a[0], c),
  TRANSPOSE: (a, c) => { const r = rangeAt(a, c, 0); const out = []; for (let cc = 0; cc <= r.c2 - r.c1; cc++) { const row = []; for (let rr = 0; rr <= r.r2 - r.r1; rr++) row.push(r.values[rr][cc]); out.push(row); } return { __range: true, values: out, r1: 0, c1: 0, r2: out.length - 1, c2: out[0] ? out[0].length - 1 : 0 }; },
  FLATTEN: (a, c) => { const vals = collectValues(a, c); return { __range: true, values: vals.map(v => [v]), r1: 0, c1: 0, r2: vals.length - 1, c2: 0 }; },
  UNIQUE: (a, c) => { const r = rangeAt(a, c, 0); const seen = new Set(); const out = []; for (const row of r.values) { const key = row.map(formatScalar).join('\u0000'); if (!seen.has(key)) { seen.add(key); out.push(row); } } return { __range: true, values: out, r1: 0, c1: 0, r2: out.length - 1, c2: (out[0] ? out[0].length - 1 : 0) }; },
  SORT: (a, c) => { const r = rangeAt(a, c, 0); const col = optNumAt(a, c, 1, 1) - 1; const asc = a.length > 2 ? boolAt(a, c, 2) : true; const rows = r.values.slice().sort((x, y) => { const cmp = compareValues('<', x[col], y[col]); return (cmp === true ? -1 : 1) * (asc ? 1 : -1); }); return { __range: true, values: rows, r1: 0, c1: 0, r2: rows.length - 1, c2: (rows[0] ? rows[0].length - 1 : 0) }; },

  // --- Engineering --------------------------------------------------------
  DEC2BIN: (a, c) => Math.floor(numAt(a, c, 0)).toString(2),
  DEC2HEX: (a, c) => Math.floor(numAt(a, c, 0)).toString(16).toUpperCase(),
  DEC2OCT: (a, c) => Math.floor(numAt(a, c, 0)).toString(8),
  BIN2DEC: (a, c) => { const v = parseInt(strAt(a, c, 0), 2); return isNaN(v) ? mkErr('#NUM!') : v; },
  HEX2DEC: (a, c) => { const v = parseInt(strAt(a, c, 0), 16); return isNaN(v) ? mkErr('#NUM!') : v; },
  OCT2DEC: (a, c) => { const v = parseInt(strAt(a, c, 0), 8); return isNaN(v) ? mkErr('#NUM!') : v; },
  BIN2HEX: (a, c) => { const v = parseInt(strAt(a, c, 0), 2); return isNaN(v) ? mkErr('#NUM!') : v.toString(16).toUpperCase(); },
  HEX2BIN: (a, c) => { const v = parseInt(strAt(a, c, 0), 16); return isNaN(v) ? mkErr('#NUM!') : v.toString(2); },

  // --- Financial ----------------------------------------------------------
  PMT: (a, c) => { const r = numAt(a, c, 0), n = numAt(a, c, 1), pv = numAt(a, c, 2), fv = optNumAt(a, c, 3, 0), type = optNumAt(a, c, 4, 0); if (r === 0) return -(pv + fv) / n; const p = Math.pow(1 + r, n); return -(pv * p + fv) * r / ((p - 1) * (1 + r * type)); },
  FV: (a, c) => { const r = numAt(a, c, 0), n = numAt(a, c, 1), pmt = numAt(a, c, 2), pv = optNumAt(a, c, 3, 0), type = optNumAt(a, c, 4, 0); if (r === 0) return -(pv + pmt * n); const p = Math.pow(1 + r, n); return -(pv * p + pmt * (1 + r * type) * (p - 1) / r); },
  PV: (a, c) => { const r = numAt(a, c, 0), n = numAt(a, c, 1), pmt = numAt(a, c, 2), fv = optNumAt(a, c, 3, 0), type = optNumAt(a, c, 4, 0); if (r === 0) return -(fv + pmt * n); const p = Math.pow(1 + r, n); return -(fv + pmt * (1 + r * type) * (p - 1) / r) / p; },
  NPV: (a, c) => { const r = numAt(a, c, 0); const vals = collectNumbers(a.slice(1), c); let total = 0; vals.forEach((v, i) => { total += v / Math.pow(1 + r, i + 1); }); return total; },
  IRR: (a, c) => { const vals = collectNumbers([a[0]], c); let rate = a.length > 1 ? numAt(a, c, 1) : 0.1; for (let iter = 0; iter < 100; iter++) { let npv = 0, d = 0; vals.forEach((v, i) => { npv += v / Math.pow(1 + rate, i); d += -i * v / Math.pow(1 + rate, i + 1); }); if (Math.abs(npv) < 1e-7) return rate; if (d === 0) break; rate -= npv / d; } return mkErr('#NUM!'); },

  // --- External services (not available offline) --------------------------
  GOOGLEFINANCE: () => mkErr('#N/A'),
  GOOGLETRANSLATE: () => mkErr('#N/A'),
  IMAGE: () => mkErr('#N/A')
};

// --- function helpers (defined after the table; referenced lazily) ----------
const stdev = (ns, sample) => { const v = variance(ns, sample); return isErr(v) ? v : Math.sqrt(v); };
const variance = (ns, sample) => { const k = sample ? 1 : 0; if (ns.length - k <= 0) return mkErr('#DIV/0!'); const m = ns.reduce((s, n) => s + n, 0) / ns.length; return ns.reduce((s, n) => s + (n - m) ** 2, 0) / (ns.length - k); };

/** Shared engine for SUMIF(S)/COUNTIF(S)/AVERAGEIF(S)/MAXIFS/MINIFS. */
const conditionalAggregate = (args, ctx, mode, plural) => {
  // Build the list of (criteriaRange, criterion) pairs plus an aggregate range.
  let aggRange = null;
  const pairs = [];
  if (mode === 'count' && !plural) { // COUNTIF(range, criterion)
    pairs.push([rangeAt(args, ctx, 0), evAt(args, ctx, 1)]);
  } else if (!plural) { // SUMIF/AVERAGEIF(range, criterion, [aggRange])
    const critRange = rangeAt(args, ctx, 0);
    const crit = evAt(args, ctx, 1);
    aggRange = args.length > 2 ? rangeAt(args, ctx, 2) : critRange;
    pairs.push([critRange, crit]);
  } else { // *IFS
    let start = 0;
    if (mode !== 'count') { aggRange = rangeAt(args, ctx, 0); start = 1; }
    for (let i = start; i + 1 < args.length; i += 2) pairs.push([rangeAt(args, ctx, i), evAt(args, ctx, i + 1)]);
  }
  const aggFlat = aggRange ? flattenRange(aggRange) : null;
  const len = flattenRange(pairs[0][0]).length;
  const flats = pairs.map(([r]) => flattenRange(r));
  const hits = [];
  for (let i = 0; i < len; i++) {
    if (pairs.every(([, crit], pi) => matchCriteria(flats[pi][i], crit))) hits.push(i);
  }
  if (mode === 'count') return hits.length;
  const picked = hits.map(i => aggFlat[i]).map(v => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? parseFloat(v) : null))).filter(v => v !== null);
  if (mode === 'sum') return picked.reduce((s, n) => s + n, 0);
  if (mode === 'avg') return picked.length ? picked.reduce((s, n) => s + n, 0) / picked.length : mkErr('#DIV/0!');
  if (mode === 'max') return picked.length ? Math.max(...picked) : 0;
  if (mode === 'min') return picked.length ? Math.min(...picked) : 0;
  return mkErr('#ERROR!');
};

/** Shared engine for VLOOKUP (vertical) and HLOOKUP (horizontal). */
const lookupVH = (args, ctx, vertical) => {
  const key = evAt(args, ctx, 0);
  const r = rangeAt(args, ctx, 1);
  const index = numAt(args, ctx, 2);
  const approx = args.length > 3 ? boolAt(args, ctx, 3) : true;
  const lines = vertical ? r.values.map(row => row[0]) : (r.values[0] || []);
  let found = -1;
  if (approx) { for (let i = 0; i < lines.length; i++) { if (compareValues('<=', lines[i], key) === true) found = i; } }
  else { for (let i = 0; i < lines.length; i++) { if (compareValues('=', lines[i], key) === true) { found = i; break; } } }
  if (found < 0) return mkErr('#N/A');
  if (vertical) { const row = r.values[found]; return (index >= 1 && index <= row.length) ? row[index - 1] : mkErr('#REF!'); }
  return (index >= 1 && index <= r.values.length) ? r.values[index - 1][found] : mkErr('#REF!');
};

/** Minimal number-format pattern support for TEXT() (handles %, decimals, thousands). */
const formatWithPattern = (n, pattern) => {
  if (isErr(n)) return n;
  if (/%/.test(pattern)) { const dec = (pattern.split('.')[1] || '').replace(/%/g, '').length; return (n * 100).toFixed(dec) + '%'; }
  const decMatch = pattern.split('.')[1];
  const dec = decMatch ? decMatch.replace(/[^0#]/g, '').length : 0;
  let s = n.toFixed(dec);
  if (/,/.test(pattern.split('.')[0] || '')) { const parts = s.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); s = parts.join('.'); }
  return s;
};

/**
 * Evaluates a formula string (e.g. =SUM(A1:A5), =IF(A1>0,"y","n")) to a display
 * string. Returns spreadsheet-style error codes (#DIV/0!, #N/A, …) on failure.
 * @param {string} formula - Formula text starting with '='.
 * @param {number} [recursionDepth=0] - Guards against circular references.
 * @param {string|null} [ownerCoord=null] - Coord of the cell holding this formula
 *   (lets ROW()/COLUMN() with no argument resolve their own position).
 * @returns {string} Evaluated display value.
 */
const evaluateFormula = (formula, recursionDepth = 0, ownerCoord = null) => {
  if (recursionDepth > 50) return '#REF!'; // circular / excessively deep reference
  if (typeof formula !== 'string' || !formula.startsWith('=')) return formula;
  try {
    const ast = parseFormula(tokenizeFormula(formula.slice(1)));
    const result = evalNode(ast, { depth: recursionDepth, owner: ownerCoord });
    if (isRange(result)) return flattenRange(result).map(formatScalar).join(', ');
    return formatScalar(result);
  } catch (e) {
    return isErr(e) ? e.__error : '#ERROR!';
  }
};

  root.CoSheet.formula = {
    evaluateFormula,
    setCellResolver(fn) { if (typeof fn === 'function') getCellValue = fn; }
  };
})();
