/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { LspTransport } from '../../src/main/agent/lsp/lspTransport.js';

interface RpcFrame {
	readonly id?: number;
	readonly method?: string;
	readonly params?: Record<string, unknown>;
	readonly result?: unknown;
}

/** Read one framed message off a stream, resolving with the parsed body. */
function readFrame(stream: PassThrough): Promise<RpcFrame> {
	return new Promise(resolve => {
		let buf = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			buf = Buffer.concat([buf, chunk]);
			const headerEnd = buf.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				return;
			}
			const length = Number(/content-length:\s*(\d+)/i.exec(buf.toString('ascii', 0, headerEnd))![1]);
			const bodyStart = headerEnd + 4;
			if (buf.length < bodyStart + length) {
				return;
			}
			stream.off('data', onData);
			resolve(JSON.parse(buf.toString('utf8', bodyStart, bodyStart + length)));
		};
		stream.on('data', onData);
	});
}

function frame(stream: PassThrough, message: unknown): void {
	const body = Buffer.from(JSON.stringify(message), 'utf8');
	stream.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'));
	stream.write(body);
}

test('LspTransport correlates a request with its response by id', async () => {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	const transport = new LspTransport(
		toServer,
		toClient,
		() => null,
		() => {},
	);

	const pending = transport.request('initialize', { x: 1 });
	const sent = await readFrame(toServer);
	assert.equal(sent.method, 'initialize');
	assert.equal(sent.params?.x, 1);
	frame(toClient, { jsonrpc: '2.0', id: sent.id, result: { ok: true } });
	assert.deepEqual(await pending, { ok: true });
	transport.dispose();
});

test('LspTransport auto-replies to a server→client request so the server never blocks', async () => {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	// The handler answers workspace/configuration with one null per item.
	const transport = new LspTransport(
		toServer,
		toClient,
		(method, params) => (method === 'workspace/configuration' ? (params as { items: unknown[] }).items.map(() => null) : null),
		() => {},
	);

	frame(toClient, { jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: { items: [{}, {}] } });
	const reply = await readFrame(toServer);
	assert.equal(reply.id, 99);
	assert.deepEqual(reply.result, [null, null]);
	transport.dispose();
});

test('LspTransport routes notifications to the handler and rejects in-flight requests on dispose', async () => {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	const notes: string[] = [];
	const transport = new LspTransport(
		toServer,
		toClient,
		() => null,
		method => notes.push(method),
	);

	frame(toClient, { jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(notes, ['window/logMessage']);

	const pending = transport.request('slow', {});
	transport.dispose('gone');
	await assert.rejects(pending, /gone/);
});

test('LspTransport surfaces an LSP error response as a rejection', async () => {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	const transport = new LspTransport(
		toServer,
		toClient,
		() => null,
		() => {},
	);
	const pending = transport.request('boom', {});
	const sent = await readFrame(toServer);
	frame(toClient, { jsonrpc: '2.0', id: sent.id, error: { code: -32601, message: 'method not found' } });
	await assert.rejects(pending, /method not found/);
	transport.dispose();
});
