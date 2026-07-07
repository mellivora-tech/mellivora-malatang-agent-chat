/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRemoteModel, ModelProvider } from '../sessions/services/models/common/models.js';

/**
 * Query a provider's list-models endpoint. Doubles as the connectivity/key
 * check when saving a provider: an auth or network failure rejects, while an
 * endpoint that simply doesn't implement list-models (404/405) resolves to an
 * empty list — reachable and authenticated is all we can verify there.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const ANTHROPIC_VERSION = '2023-06-01';

export interface IRemoteModelsConnection {
	readonly type: ModelProvider;
	readonly baseURL: string;
	readonly apiKey?: string;
}

/**
 * Verify a provider connection end to end. The list-models endpoint alone is
 * no proof the key works — several gateways serve it unauthenticated or don't
 * implement it — so a one-token chat probe is the authoritative key check.
 * Non-auth request errors (unknown model, validation) still pass: the key was
 * accepted before the request could fail that way.
 */
export async function verifyProviderConnection(connection: IRemoteModelsConnection, probeModel: string | undefined): Promise<void> {
	const models = await fetchRemoteModels(connection);
	const model = probeModel ?? models[0]?.id;
	if (model) {
		await probeChat(connection, model);
	}
}

async function probeChat(connection: IRemoteModelsConnection, model: string): Promise<void> {
	const base = connection.baseURL.replace(/\/$/, '');
	const endpoint = connection.type === 'anthropic' ? `${base}/v1/messages` : `${base}/chat/completions`;
	const message = { role: 'user', content: 'ping' };
	const body = connection.type === 'anthropic' ? { model, max_tokens: 1, messages: [message] } : { model, max_tokens: 1, stream: false, messages: [message] };
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		...(connection.type === 'anthropic'
			? { 'x-api-key': connection.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION }
			: { authorization: `Bearer ${connection.apiKey ?? ''}` }),
	};

	let response: Response;
	try {
		response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (error) {
		const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'connection failed';
		throw new Error(`Could not reach ${endpoint} (${detail}).`, { cause: error });
	}

	if (response.status === 401 || response.status === 403) {
		throw new Error(`The provider rejected the API key (HTTP ${response.status}).`);
	}
	if (response.status === 402) {
		throw new Error('The API key was accepted but the account has insufficient balance (HTTP 402).');
	}
	// Request-level failures (unknown model, validation, rate limit) mean the
	// key cleared auth — that is all this probe asserts.
	if (!response.ok && ![400, 404, 405, 413, 422, 429].includes(response.status)) {
		throw new Error(`The provider returned HTTP ${response.status}.`);
	}
}

export async function fetchRemoteModels(connection: IRemoteModelsConnection): Promise<readonly IRemoteModel[]> {
	const base = connection.baseURL.replace(/\/$/, '');
	const endpoint = connection.type === 'anthropic' ? `${base}/v1/models` : `${base}/models`;
	const headers: Record<string, string> =
		connection.type === 'anthropic' ? { 'x-api-key': connection.apiKey ?? '', 'anthropic-version': ANTHROPIC_VERSION } : { authorization: `Bearer ${connection.apiKey ?? ''}` };

	let response: Response;
	try {
		response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	} catch (error) {
		const detail = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'connection failed';
		throw new Error(`Could not reach ${endpoint} (${detail}).`, { cause: error });
	}

	if (response.status === 401 || response.status === 403) {
		throw new Error(`The provider rejected the API key (HTTP ${response.status}).`);
	}
	if (response.status === 404 || response.status === 405) {
		return [];
	}
	if (!response.ok) {
		throw new Error(`The provider returned HTTP ${response.status}.`);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error('The provider returned an unexpected response (not JSON).');
	}

	return parseModelList(payload);
}

/** Both wire formats list models as `{ data: [{ id, ... }] }`. */
function parseModelList(payload: unknown): IRemoteModel[] {
	if (typeof payload !== 'object' || payload === null) {
		return [];
	}
	const data = (payload as Record<string, unknown>)['data'];
	if (!Array.isArray(data)) {
		return [];
	}

	const models: IRemoteModel[] = [];
	for (const entry of data) {
		if (typeof entry !== 'object' || entry === null) {
			continue;
		}
		const candidate = entry as Record<string, unknown>;
		const id = candidate['id'];
		if (typeof id !== 'string' || id.length === 0) {
			continue;
		}
		const contextLength = candidate['max_input_tokens'];
		models.push({ id, ...(typeof contextLength === 'number' && contextLength > 0 ? { contextLength } : {}) });
	}

	return models;
}
