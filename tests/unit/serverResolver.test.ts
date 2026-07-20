/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { languageForPath, resolveServer } from '../../src/main/agent/lsp/serverResolver.js';

test('languageForPath maps known extensions and rejects the rest', () => {
	assert.equal(languageForPath('/a/Foo.java'), 'java');
	assert.equal(languageForPath('/a/foo.ts'), 'typescript');
	assert.equal(languageForPath('/a/foo.tsx'), 'typescript');
	assert.equal(languageForPath('/a/foo.js'), 'typescript');
	assert.equal(languageForPath('/a/App.vue'), 'vue');
	assert.equal(languageForPath('/a/readme.md'), undefined);
	assert.equal(languageForPath('/a/data.sql'), undefined);
});

test('an override wins unconditionally — even a command not on PATH', () => {
	const spec = resolveServer('java', { java: ['/opt/my/jdtls', '--flag'] });
	assert.deepEqual(spec, { language: 'java', command: '/opt/my/jdtls', args: ['--flag'] });
});

test('with no override and nothing on PATH, resolution returns undefined (graceful "no server")', () => {
	const savedPath = process.env.PATH;
	process.env.PATH = ''; // force every default command to be "not found"
	try {
		assert.equal(resolveServer('java'), undefined);
		assert.equal(resolveServer('typescript'), undefined);
		assert.equal(resolveServer('vue'), undefined);
	} finally {
		process.env.PATH = savedPath;
	}
});
