/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { Readable, Writable } from 'node:stream';

/**
 * Minimal LSP JSON-RPC transport over a child process's stdio.
 *
 * We frame messages ourselves (Content-Length header + `\r\n\r\n` + JSON body)
 * rather than pull in vscode-jsonrpc: the protocol surface we use is small, and
 * a self-contained reader is trivially testable against an in-memory pipe or a
 * fake server child — no real language server required to verify framing,
 * id-correlation, and server-request auto-reply.
 */

type Json = unknown;

interface IPendingRequest {
	readonly resolve: (result: Json) => void;
	readonly reject: (error: Error) => void;
}

interface IJsonRpcMessage {
	readonly jsonrpc?: string;
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: Json;
	readonly result?: Json;
	readonly error?: { readonly code: number; readonly message: string };
}

/** A server→client request the transport must answer, or the server may block. */
export type ServerRequestHandler = (method: string, params: Json) => Json;

/** A server→client notification (progress, diagnostics, logs). */
export type NotificationHandler = (method: string, params: Json) => void;

export class LspTransport {
	private readonly pending = new Map<number, IPendingRequest>();
	private nextId = 1;
	private buffer = Buffer.alloc(0);
	private closed = false;
	private closeReason: string | undefined;

	constructor(
		private readonly stdin: Writable,
		stdout: Readable,
		private readonly onServerRequest: ServerRequestHandler,
		private readonly onNotification: NotificationHandler,
	) {
		stdout.on('data', chunk => this.onData(chunk as Buffer));
		stdout.on('close', () => this.fail('language server stdout closed'));
	}

	/** Send a request and await its response. Rejects if the server errors or dies. */
	request(method: string, params: Json): Promise<Json> {
		if (this.closed) {
			return Promise.reject(new Error(this.closeReason ?? 'transport closed'));
		}
		const id = this.nextId++;
		const message = { jsonrpc: '2.0', id, method, params };
		return new Promise<Json>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write(message);
		});
	}

	/** Fire-and-forget notification (no id, no response). */
	notify(method: string, params: Json): void {
		if (this.closed) {
			return;
		}
		this.write({ jsonrpc: '2.0', method, params });
	}

	/** Reject every in-flight request; further calls fail fast. Idempotent. */
	dispose(reason = 'transport disposed'): void {
		this.fail(reason);
	}

	private write(message: Json): void {
		const body = Buffer.from(JSON.stringify(message), 'utf8');
		const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
		this.stdin.write(Buffer.concat([header, body]));
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		// Drain every complete frame currently in the buffer.
		for (;;) {
			const headerEnd = this.buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				return;
			}
			const header = this.buffer.toString('ascii', 0, headerEnd);
			const match = /content-length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Unframeable header — drop it and resync past the separator.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) {
				return; // body not fully arrived yet
			}
			const body = this.buffer.toString('utf8', bodyStart, bodyStart + length);
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.dispatch(body);
		}
	}

	private dispatch(body: string): void {
		let message: IJsonRpcMessage;
		try {
			message = JSON.parse(body) as IJsonRpcMessage;
		} catch {
			return; // malformed frame — ignore rather than crash the run
		}

		// Response to one of our requests: id present, method absent.
		if (message.method === undefined && message.id !== undefined) {
			const pending = this.pending.get(Number(message.id));
			if (!pending) {
				return;
			}
			this.pending.delete(Number(message.id));
			if (message.error) {
				pending.reject(new Error(`LSP error ${message.error.code}: ${message.error.message}`));
			} else {
				pending.resolve(message.result ?? null);
			}
			return;
		}

		// Server→client request (id present, method present): must answer or it blocks.
		if (message.method !== undefined && message.id !== undefined) {
			let result: Json;
			try {
				result = this.onServerRequest(message.method, message.params ?? null);
			} catch {
				result = null;
			}
			this.write({ jsonrpc: '2.0', id: message.id, result });
			return;
		}

		// Notification (method present, no id).
		if (message.method !== undefined) {
			this.onNotification(message.method, message.params ?? null);
		}
	}

	private fail(reason: string): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.closeReason = reason;
		for (const pending of this.pending.values()) {
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
