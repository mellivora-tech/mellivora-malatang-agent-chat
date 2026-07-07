/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Yield the payload of each `data:` line from a Server-Sent Events stream. Both
 * the OpenAI-compatible and the Anthropic streaming APIs put a JSON object on
 * every `data:` line (Anthropic also emits `event:` lines, which carry no
 * payload we need — the `type` is inside the data object).
 */
export async function* readServerSentEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}

			if (value) {
				buffer += decoder.decode(value, { stream: true });
			}

			let newline = buffer.indexOf('\n');
			while (newline !== -1) {
				const line = buffer.slice(0, newline).replace(/\r$/, '');
				buffer = buffer.slice(newline + 1);
				if (line.startsWith('data:')) {
					yield line.slice(5).trim();
				}

				newline = buffer.indexOf('\n');
			}
		}
	} finally {
		reader.releaseLock();
	}

	const rest = buffer.replace(/\r$/, '');
	if (rest.startsWith('data:')) {
		yield rest.slice(5).trim();
	}
}
