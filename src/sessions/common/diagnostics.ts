/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Report a failure the renderer caught, so it lands in the log file.
 *
 * Use this anywhere a `catch` would otherwise end at `console.warn`. In Electron
 * a renderer's console reaches only that window's DevTools — it does not go to
 * the terminal and nothing writes it to disk. An audit traced a whole class of
 * "the feature just didn't work and no log says why" bugs to exactly that: the
 * error WAS thrown and WAS caught, but the only handler wrote somewhere nobody
 * would ever look.
 *
 * The console call is kept as well — it stays useful while developing with
 * DevTools open; the IPC send is what makes the failure survive.
 */

type DiagnosticsGlobals = typeof globalThis & {
	readonly agentWindow?: {
		readonly diagnostics?: { report(payload: { scope: string; message?: string; errorClass?: string; sessionId?: string }): void };
	};
};

function classify(error: unknown): string | undefined {
	if (error instanceof Error) {
		return error.name !== '' ? error.name : error.constructor?.name;
	}
	return typeof error;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * @param scope where it happened, e.g. `sessions.generateTitle` — this is the
 * string a maintainer greps for, so name the operation, not the file.
 * @param sessionId when the failure belongs to a session, so it can be tied back
 * to that transcript.
 */
export function reportFailure(scope: string, error: unknown, sessionId?: string): void {
	console.warn(`${scope} failed:`, error);
	// Reporting must never itself throw — the bridge is absent in tests and in a
	// plain browser, and a logging failure must not replace the original one.
	try {
		const errorClass = classify(error);
		(globalThis as DiagnosticsGlobals).agentWindow?.diagnostics?.report({
			scope,
			message: describe(error),
			...(errorClass !== undefined ? { errorClass } : {}),
			...(sessionId !== undefined ? { sessionId } : {}),
		});
	} catch {
		// Nothing left to do — the console call above already happened.
	}
}
