/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDataSourceSecret, IServerCoordinates } from '../../sessions/services/environments/common/environments.js';

const MAX_OUTPUT = 30_000;

export interface ISshResult {
	/** The command's exit code, or null if it never completed (connect error / timeout / abort). */
	readonly code: number | null;
	readonly output: string;
}

export type SshRunner = (coordinates: IServerCoordinates, secret: IDataSourceSecret | undefined, command: string, options: { readonly signal: AbortSignal; readonly timeoutMs: number }) => Promise<ISshResult>;

/**
 * Open an SSH connection, run one command, and return its combined stdout/stderr
 * + exit code. Never throws — connection/exec failures come back as a result
 * with `code: null` and the error in `output`. Uses the system's credentials via
 * the stored password or private key.
 */
export const runSsh: SshRunner = async (coordinates, secret, command, { signal, timeoutMs }) => {
	const { Client } = await import('ssh2');
	return new Promise<ISshResult>(resolve => {
		const conn = new Client();
		let output = '';
		let settled = false;

		const finish = (result: ISshResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
			try {
				conn.end();
			} catch {
				// already closed
			}
			resolve(result);
		};
		const fail = (note: string): void => finish({ code: null, output: `${output}${note}`.slice(0, MAX_OUTPUT) });

		const timer = setTimeout(() => fail(`\n[SSH timed out after ${timeoutMs}ms]`), timeoutMs);
		const onAbort = (): void => fail('\n[SSH aborted]');
		signal.addEventListener('abort', onAbort, { once: true });

		const collect = (chunk: Buffer): void => {
			if (output.length < MAX_OUTPUT) {
				output += chunk.toString('utf8');
			}
		};

		conn.on('ready', () => {
			conn.exec(command, (error, stream) => {
				if (error) {
					fail(`\n[SSH exec error: ${error.message}]`);
					return;
				}
				stream.on('close', (code: number | null) => finish({ code: code ?? null, output: output.slice(0, MAX_OUTPUT) }));
				stream.on('data', collect);
				stream.stderr.on('data', collect);
			});
		});
		conn.on('error', error => fail(`\n[SSH connection error: ${error.message}]`));

		conn.connect({
			host: coordinates.host,
			port: coordinates.port,
			username: coordinates.user,
			readyTimeout: 8_000,
			...(coordinates.auth === 'key' ? { privateKey: secret?.privateKey ?? '' } : { password: secret?.password ?? '' }),
		});
	});
};
