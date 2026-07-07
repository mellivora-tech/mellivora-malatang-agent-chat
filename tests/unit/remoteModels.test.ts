/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { fetchRemoteModels, verifyProviderConnection } from '../../src/main/remoteModels.js';

interface ITestServer {
	readonly baseURL: string;
	lastRequest: { url: string; headers: IncomingMessage['headers'] } | undefined;
	close(): Promise<void>;
}

function startServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<ITestServer> {
	return new Promise(resolve => {
		const state: { lastRequest: ITestServer['lastRequest'] } = { lastRequest: undefined };
		const server: Server = createServer((request, response) => {
			state.lastRequest = { url: request.url ?? '', headers: request.headers };
			handler(request, response);
		});
		server.listen(0, '127.0.0.1', () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				baseURL: `http://127.0.0.1:${port}`,
				get lastRequest() {
					return state.lastRequest;
				},
				set lastRequest(value) {
					state.lastRequest = value;
				},
				close: () => new Promise<void>(done => server.close(() => done())),
			});
		});
	});
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

test('openai-compatible: hits {base}/models with a bearer key and parses ids', async () => {
	const server = await startServer((_request, response) => json(response, 200, { object: 'list', data: [{ id: 'glm-5.2' }, { id: 'glm-5-turbo' }] }));
	try {
		const models = await fetchRemoteModels({ type: 'openai-compatible', baseURL: `${server.baseURL}/v1`, apiKey: 'sk-test' });
		assert.deepEqual(
			models.map(model => model.id),
			['glm-5.2', 'glm-5-turbo'],
		);
		assert.equal(server.lastRequest?.url, '/v1/models');
		assert.equal(server.lastRequest?.headers.authorization, 'Bearer sk-test');
	} finally {
		await server.close();
	}
});

test('anthropic: hits {base}/v1/models with api-key headers and maps max_input_tokens', async () => {
	const server = await startServer((_request, response) => json(response, 200, { data: [{ id: 'claude-opus-4-8', max_input_tokens: 1000000 }] }));
	try {
		const models = await fetchRemoteModels({ type: 'anthropic', baseURL: server.baseURL, apiKey: 'sk-ant' });
		assert.deepEqual(models, [{ id: 'claude-opus-4-8', contextLength: 1000000 }]);
		assert.equal(server.lastRequest?.url, '/v1/models');
		assert.equal(server.lastRequest?.headers['x-api-key'], 'sk-ant');
		assert.equal(server.lastRequest?.headers['anthropic-version'], '2023-06-01');
	} finally {
		await server.close();
	}
});

test('a rejected key (401) fails with an auth message', async () => {
	const server = await startServer((_request, response) => json(response, 401, { error: { message: 'bad key' } }));
	try {
		await assert.rejects(fetchRemoteModels({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'bad' }), /rejected the API key \(HTTP 401\)/);
	} finally {
		await server.close();
	}
});

test('a missing list-models endpoint (404) passes verification with no candidates', async () => {
	const server = await startServer((_request, response) => json(response, 404, { error: 'not found' }));
	try {
		const models = await fetchRemoteModels({ type: 'anthropic', baseURL: server.baseURL, apiKey: 'sk' });
		assert.deepEqual(models, []);
	} finally {
		await server.close();
	}
});

test('a server error (500) fails verification', async () => {
	const server = await startServer((_request, response) => json(response, 500, {}));
	try {
		await assert.rejects(fetchRemoteModels({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }), /HTTP 500/);
	} finally {
		await server.close();
	}
});

test('an unreachable endpoint fails with a connection message', async () => {
	const server = await startServer((_request, response) => json(response, 200, { data: [] }));
	await server.close();
	await assert.rejects(fetchRemoteModels({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }), /Could not reach/);
});

test('verify: an unauthenticated list-models endpoint alone does not pass — the chat probe catches a bad key', async () => {
	const requests: string[] = [];
	const server = await startServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		if (request.method === 'GET') {
			json(response, 200, { data: [{ id: 'served-model' }] });
			return;
		}
		json(response, 401, { error: { message: 'bad key' } });
	});
	try {
		await assert.rejects(verifyProviderConnection({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'bad' }, undefined), /rejected the API key \(HTTP 401\)/);
		assert.deepEqual(requests, ['GET /models', 'POST /chat/completions']);
	} finally {
		await server.close();
	}
});

test('verify: passes when the probe succeeds, preferring the given probe model', async () => {
	const bodies: string[] = [];
	const server = await startServer((request, response) => {
		if (request.method === 'GET') {
			json(response, 200, { data: [{ id: 'other-model' }] });
			return;
		}
		let raw = '';
		request.on('data', chunk => (raw += String(chunk)));
		request.on('end', () => {
			bodies.push(raw);
			json(response, 200, { choices: [{ message: { content: 'pong' } }] });
		});
	});
	try {
		await verifyProviderConnection({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }, 'glm-5.2');
		const body = JSON.parse(bodies[0] ?? '{}') as { model: string; max_tokens: number; stream: boolean };
		assert.equal(body.model, 'glm-5.2');
		assert.equal(body.max_tokens, 1);
		assert.equal(body.stream, false);
	} finally {
		await server.close();
	}
});

test('verify: anthropic probes POST {base}/v1/messages with api-key headers', async () => {
	const requests: string[] = [];
	const server = await startServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		if (request.method === 'GET') {
			json(response, 404, {});
			return;
		}
		assert.equal(request.headers['x-api-key'], 'sk-ant');
		assert.equal(request.headers['anthropic-version'], '2023-06-01');
		json(response, 200, { content: [] });
	});
	try {
		await verifyProviderConnection({ type: 'anthropic', baseURL: server.baseURL, apiKey: 'sk-ant' }, 'kimi-k2.7-code');
		assert.deepEqual(requests, ['GET /v1/models', 'POST /v1/messages']);
	} finally {
		await server.close();
	}
});

test('verify: request-level probe failures (unknown model, rate limit) still pass — auth was accepted', async () => {
	for (const status of [400, 404, 429]) {
		const server = await startServer((request, response) => {
			if (request.method === 'GET') {
				json(response, 200, { data: [{ id: 'm' }] });
				return;
			}
			json(response, status, { error: { message: 'request rejected' } });
		});
		try {
			await verifyProviderConnection({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }, undefined);
		} finally {
			await server.close();
		}
	}
});

test('verify: insufficient balance (402) fails with a specific message', async () => {
	const server = await startServer((request, response) => {
		if (request.method === 'GET') {
			json(response, 200, { data: [{ id: 'm' }] });
			return;
		}
		json(response, 402, { error: { message: 'insufficient balance' } });
	});
	try {
		await assert.rejects(verifyProviderConnection({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }, undefined), /insufficient balance \(HTTP 402\)/);
	} finally {
		await server.close();
	}
});

test('verify: no probe model anywhere degrades to the reachability check only', async () => {
	const requests: string[] = [];
	const server = await startServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		json(response, 404, {});
	});
	try {
		await verifyProviderConnection({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' }, undefined);
		assert.deepEqual(requests, ['GET /models']);
	} finally {
		await server.close();
	}
});

test('malformed entries are skipped and non-JSON bodies fail', async () => {
	const server = await startServer((_request, response) => json(response, 200, { data: [{ id: 'ok' }, { nope: true }, 'junk', { id: '' }] }));
	try {
		const models = await fetchRemoteModels({ type: 'openai-compatible', baseURL: server.baseURL, apiKey: 'sk' });
		assert.deepEqual(models, [{ id: 'ok' }]);
	} finally {
		await server.close();
	}

	const htmlServer = await startServer((_request, response) => {
		response.writeHead(200, { 'content-type': 'text/html' });
		response.end('<html>welcome</html>');
	});
	try {
		await assert.rejects(fetchRemoteModels({ type: 'openai-compatible', baseURL: htmlServer.baseURL, apiKey: 'sk' }), /not JSON/);
	} finally {
		await htmlServer.close();
	}
});
