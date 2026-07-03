/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const copies = [
  ['dist/src/main', 'dist/main'],
  ['dist/src/preload', 'dist/preload'],
  ['dist/src/sessions', 'dist/sessions'],
  ['src/sessions/electron-browser/sessions.html', 'dist/sessions/electron-browser/sessions.html'],
  ['src/sessions/browser/media', 'dist/sessions/browser/media'],
  ['src/sessions/browser/parts/media', 'dist/sessions/browser/parts/media'],
  ['node_modules/@vscode/codicons/dist/codicon.css', 'dist/assets/codicons/codicon.css'],
  ['node_modules/@vscode/codicons/dist/codicon.ttf', 'dist/assets/codicons/codicon.ttf']
];

for (const [from, to] of copies) {
  await mkdir(join(root, dirname(to)), { recursive: true });
  await cp(join(root, from), join(root, to), { recursive: true });
}
