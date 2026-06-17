/**
 * @file app-bundle.js
 * @description Test helper that reconstructs the full client script the browser
 * loads. app.js was split into separate classic scripts (sheet-utils.js,
 * formula-engine.js, i18n.js) that publish onto window.CoSheet; app.js binds
 * them at the top. The vm-based tests eval a single string, so concatenate the
 * modules ahead of app.js in the same order as the <script defer> tags in
 * private/index.html. The lone ';' separators guard against ASI edge cases.
 */
import fs from 'fs';
import path from 'path';

const read = (f) => fs.readFileSync(path.resolve('public', f), 'utf8');

export function readAppBundle() {
  return [
    read('sheet-utils.js'),
    read('formula-engine.js'),
    read('formula-refs.js'),
    read('i18n.js'),
    read('app.js')
  ].join('\n;\n');
}
