/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import { reportFailure } from '../../src/sessions/common/diagnostics.js';

interface IReport {
	scope: string;
	message?: string;
	errorClass?: string;
	sessionId?: string;
}

/** Stand in for the preload bridge; returns the reports it received. */
function withBridge(run: () => void, report: (payload: IReport) => void = () => undefined): IReport[] {
	const received: IReport[] = [];
	const globals = globalThis as { agentWindow?: unknown };
	const previous = globals.agentWindow;
	globals.agentWindow = {
		diagnostics: {
			report: (payload: IReport) => {
				received.push(payload);
				report(payload);
			},
		},
	};
	try {
		run();
	} finally {
		globals.agentWindow = previous;
	}
	return received;
}

test('reportFailure: a caught renderer failure reaches the log bridge, not just DevTools', t => {
	t.mock.method(console, 'warn', () => undefined);
	const reports = withBridge(() => reportFailure('sessions.generateTitle', new TypeError('model refused'), 'session-7'));

	assert.equal(reports.length, 1);
	assert.deepEqual(reports[0], {
		scope: 'sessions.generateTitle',
		message: 'model refused',
		errorClass: 'TypeError',
		sessionId: 'session-7',
	});
});

test('reportFailure: sessionId is omitted for failures outside any session', t => {
	t.mock.method(console, 'warn', () => undefined);
	const reports = withBridge(() => reportFailure('projects.listFiles', new Error('EACCES')));

	assert.equal(reports[0]?.sessionId, undefined, 'project/skills/artifacts failures belong to no transcript');
	assert.equal(reports[0]?.scope, 'projects.listFiles');
});

test('reportFailure: still writes to the console (DevTools stays useful while developing)', t => {
	const warn = t.mock.method(console, 'warn', () => undefined);
	withBridge(() => reportFailure('skills.list', new Error('boom')));
	assert.ok(warn.mock.callCount() >= 1);
});

test('reportFailure: never throws when the bridge is absent or itself fails', t => {
	t.mock.method(console, 'warn', () => undefined);

	// No preload bridge at all (unit tests, a plain browser).
	const globals = globalThis as { agentWindow?: unknown };
	const previous = globals.agentWindow;
	globals.agentWindow = undefined;
	assert.doesNotThrow(() => reportFailure('artifacts.list', new Error('boom')));
	globals.agentWindow = previous;

	// A bridge that throws must not replace the original failure with its own.
	assert.doesNotThrow(() =>
		withBridge(
			() => reportFailure('artifacts.list', new Error('boom')),
			() => {
				throw new Error('the IPC send itself failed');
			},
		),
	);
});

test('reportFailure: non-Error throws are still reported', t => {
	t.mock.method(console, 'warn', () => undefined);
	const reports = withBridge(() => reportFailure('sessions.storeImage', 'a bare string', 'session-1'));
	assert.equal(reports[0]?.message, 'a bare string');
	assert.equal(reports[0]?.errorClass, 'string');
});
