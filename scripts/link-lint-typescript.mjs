/**---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// typescript-eslint has no TypeScript 7 support yet (peer range <6.1.0; the Go-based compiler
// changed the API surface typescript-estree depends on), and npm overrides cannot nest a peer
// dependency next to the hoisted root install. So the compiler runs TypeScript 7 while the lint
// stack gets its own TypeScript 6 — the `typescript6` npm alias — spliced into its resolution
// path here. Delete this script, the postinstall hook, and the `typescript6` devDependency once
// typescript-eslint declares TypeScript 7 support.

import { mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ts6 = join(root, 'node_modules/typescript6');

// Every package that does require('typescript') on the lint path must land on the spliced copy.
// typescript-eslint's own packages sit under its nested node_modules; ts-api-utils is hoisted
// to the root and needs its own splice.
const hosts = ['node_modules/typescript-eslint', 'node_modules/ts-api-utils'];

for (const host of hosts) {
	const linkDir = join(root, host, 'node_modules');
	const link = join(linkDir, 'typescript');
	mkdirSync(linkDir, { recursive: true });
	rmSync(link, { recursive: true, force: true });
	symlinkSync(relative(linkDir, ts6), link, 'junction');
}

// The typescript6 alias declares the same `tsc` bin name as the real package and can win the
// .bin link; `tsc` in scripts must stay TypeScript 7. Relink it (npm on Windows writes text
// shims instead of symlinks — those are only checked below, not rewritten).
const binLink = join(root, 'node_modules/.bin/tsc');
if (process.platform !== 'win32') {
	rmSync(binLink, { force: true });
	symlinkSync(join('..', 'typescript', 'bin', 'tsc'), binLink);
}

// Fail the install loudly if anything still resolves the wrong copy — a silent miss would
// surface later as a lint crash with a confusing stack. Probe from the packages' actual
// on-disk entry points, exactly like their own require('typescript') would.
const fromRoot = createRequire(join(root, 'package.json'));
const fromMeta = createRequire(fromRoot.resolve('typescript-eslint'));
const chains = [['@typescript-eslint/typescript-estree'], ['@typescript-eslint/eslint-plugin', 'ts-api-utils']];
for (const chain of chains) {
	let resolver = fromMeta;
	for (const link of chain) resolver = createRequire(resolver.resolve(link));
	const resolved = resolver.resolve('typescript');
	if (!resolved.includes(`${sep}typescript6${sep}`)) {
		throw new Error(`${chain.join(' → ')} resolves typescript at ${resolved}; expected the spliced TypeScript 6. Update scripts/link-lint-typescript.mjs.`);
	}
}
const binTarget = process.platform === 'win32' ? readFileSync(binLink, 'utf8') : readlinkSync(binLink);
if (binTarget.includes('typescript6')) {
	throw new Error(`node_modules/.bin/tsc points at the lint-only TypeScript 6 (${binTarget.trim()}); tsc must stay TypeScript 7.`);
}
