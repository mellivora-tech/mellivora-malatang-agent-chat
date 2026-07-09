/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleActivate, handleWindowAllClosed, type IAppLifecycleHost } from '../../src/main/appLifecycle.js';

function createHost(platform: NodeJS.Platform, windowCount: number) {
	let quitCalls = 0;
	let createCalls = 0;
	const host: IAppLifecycleHost = {
		platform,
		getWindowCount: () => windowCount,
		createWindow: async () => {
			createCalls += 1;
		},
		quit: () => {
			quitCalls += 1;
		},
	};
	return { host, quitCalls: () => quitCalls, createCalls: () => createCalls };
}

test('window-all-closed quits on non-darwin platforms', () => {
	const { host, quitCalls } = createHost('win32', 0);
	handleWindowAllClosed(host);
	assert.equal(quitCalls(), 1);
});

test('window-all-closed keeps the app alive on darwin', () => {
	const { host, quitCalls } = createHost('darwin', 0);
	handleWindowAllClosed(host);
	assert.equal(quitCalls(), 0);
});

test('activate recreates a window when none are open', () => {
	const { host, createCalls } = createHost('darwin', 0);
	handleActivate(host);
	assert.equal(createCalls(), 1);
});

test('activate does nothing while a window is open', () => {
	const { host, createCalls } = createHost('darwin', 1);
	handleActivate(host);
	assert.equal(createCalls(), 0);
});
