/**---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const codiconsDest = join(root, 'public/assets/codicons');

await mkdir(codiconsDest, { recursive: true });
await cp(join(root, 'node_modules/@vscode/codicons/dist/codicon.css'), join(codiconsDest, 'codicon.css'));
await cp(join(root, 'node_modules/@vscode/codicons/dist/codicon.ttf'), join(codiconsDest, 'codicon.ttf'));
