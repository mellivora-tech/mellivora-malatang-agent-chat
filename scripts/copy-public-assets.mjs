/**---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
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

// App logo: tracked source lives in resources/logo, served from /assets/logo at runtime.
const logoDest = join(root, 'public/assets/logo');
await mkdir(logoDest, { recursive: true });
for (const name of ['logo.svg', 'logo-mark.svg', 'logo-app.svg']) {
	await cp(join(root, 'resources/logo', name), join(logoDest, name));
}
