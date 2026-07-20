/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A minimal stdio LSP server for tests — enough to exercise LanguageServerManager
 * without a real jdtls/volar. Argv[2] is the fixture file URI it reports for
 * workspace/symbol. It always defines one symbol, "targetFn", spanning lines
 * 2–4 (0-based) so a fixture that puts a 3-line function there round-trips.
 * Self-contained: Node globals only, no imports.
 */

const fixtureUri = process.argv[2] ?? '';

const SYMBOL_NAME = 'targetFn';
const BODY_RANGE = { start: { line: 2, character: 0 }, end: { line: 4, character: 1 } };
const NAME_RANGE = { start: { line: 2, character: 9 }, end: { line: 2, character: 9 + SYMBOL_NAME.length } };

function send(message: unknown): void {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	process.stdout.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'));
	process.stdout.write(body);
}

function handle(message: { id?: number | string; method?: string }): void {
	const { id, method } = message;
	if (method === 'initialize') {
		send({ jsonrpc: '2.0', id, result: { capabilities: { documentSymbolProvider: true, workspaceSymbolProvider: true } } });
		return;
	}
	if (method === 'shutdown') {
		send({ jsonrpc: '2.0', id, result: null });
		return;
	}
	if (method === 'exit') {
		process.exit(0);
	}
	if (method === 'textDocument/documentSymbol') {
		send({ jsonrpc: '2.0', id, result: [{ name: SYMBOL_NAME, kind: 12, range: BODY_RANGE, selectionRange: NAME_RANGE }] });
		return;
	}
	if (method === 'workspace/symbol') {
		send({ jsonrpc: '2.0', id, result: [{ name: SYMBOL_NAME, kind: 12, location: { uri: fixtureUri, range: NAME_RANGE } }] });
		return;
	}
	// initialized / didOpen are notifications (no id); other requests get a null result.
	if (id !== undefined) {
		send({ jsonrpc: '2.0', id, result: null });
	}
}

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (headerEnd === -1) {
			return;
		}
		const header = buffer.toString('ascii', 0, headerEnd);
		const match = /content-length:\s*(\d+)/i.exec(header);
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number(match[1]);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) {
			return;
		}
		const body = buffer.toString('utf8', bodyStart, bodyStart + length);
		buffer = buffer.subarray(bodyStart + length);
		try {
			handle(JSON.parse(body) as { id?: number | string; method?: string });
		} catch {
			// ignore malformed frames
		}
	}
});
