/**
 * @file fill-handle-cursor.test.js
 * @description Guards the crosshair affordance on the selection fill handle.
 * The dot at the bottom-right corner of the local selection must show a
 * crosshair cursor on hover so the user knows it is a distinct target. Two
 * CSS details make this work and are easy to regress:
 *
 * 1. The dot's parent, #selection-range-overlay, is pointer-events:none (so
 *    the overlay never blocks cell clicks). The handle therefore has to opt
 *    back in with pointer-events:auto or it can never be hovered and the
 *    cursor rule is dead code.
 * 2. The rule must be scoped to #selection-range-overlay, because the same
 *    .fill-handle class is reused for remote collaborators' cursor dots
 *    (inside .active-cell-border), which must stay inert — a peer's dot is
 *    presence decoration, not something the local user can grab.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

/** Returns the declaration block of the first CSS rule in `css` whose selector
 *  matches `selectorPattern`, or null if no such rule exists. */
function ruleBody(css, selectorPattern) {
  const re = new RegExp(`(^|[}])\\s*(${selectorPattern.source})\\s*\\{([^}]*)\\}`, 'm');
  const m = re.exec(css);
  return m ? m[3] : null;
}

const html = fs.readFileSync(path.resolve('private/index.html'), 'utf8');

test('the local selection fill handle shows a crosshair cursor on hover', () => {
  const body = ruleBody(html, /#selection-range-overlay\s+\.fill-handle/);
  assert.ok(body, 'index.html should style the overlay fill handle (#selection-range-overlay .fill-handle)');
  assert.match(body, /cursor:\s*crosshair/, 'the fill handle should use the crosshair cursor');
  assert.match(
    body, /pointer-events:\s*auto/,
    'the handle must re-enable pointer events (its parent overlay is pointer-events:none) or the hover cursor can never appear',
  );
});

test('remote peers\' fill-handle dots stay non-interactive', () => {
  // The shared .fill-handle base rule must not switch pointer events back on,
  // otherwise every remote collaborator's dot would intercept clicks on the
  // cell underneath it.
  const base = ruleBody(html, /\.fill-handle/);
  assert.ok(base, 'index.html should contain the base .fill-handle rule');
  assert.doesNotMatch(base, /pointer-events/, 'the base .fill-handle rule must leave pointer-events alone (remote dots inherit none from .active-cell-border)');
});
