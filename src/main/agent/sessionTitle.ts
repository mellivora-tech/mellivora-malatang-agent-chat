/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IModelClient } from './agentTypes.js';

/**
 * One-shot session-title generation: a single no-tools, no-thinking model call
 * over the first user message. Deliberately NOT the agent loop — no loop guard,
 * no reply verifier, no system-prompt instructions ride along; a title is a
 * best-effort nicety and must stay cheap.
 */

const TITLE_SYSTEM = [
	'You name chat sessions. Given the first user message of a session, reply with a short title capturing what the user wants.',
	'Rules: answer in the same language as the message; at most 16 characters for CJK languages or 6 words otherwise;',
	'plain text only — no quotes, no trailing punctuation, no markdown, no explanations. Reply with the title and nothing else.',
].join(' ');

/** The first message can be a huge paste; the model only needs the head to name it. */
const MAX_QUERY_CHARS = 2000;
const MAX_TITLE_CHARS = 60;

/** First line, unquoted, whitespace-collapsed, capped — or undefined when nothing usable remains. */
export function sanitizeSessionTitle(raw: string): string | undefined {
	let title = raw.trim().split('\n', 1)[0]!.trim();
	// Trailing quotes and punctuation interleave ("标题"。) — one combined class handles any mix.
	title = title.replace(/^[\s"'“”‘’`«»]+/, '').replace(/[\s"'“”‘’`«»。．.！!？?，,、;；:：]+$/, '');
	title = title.replace(/\s+/g, ' ').trim();
	if (title === '') {
		return undefined;
	}
	return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title;
}

/** Resolves to the cleaned title, or undefined when the model returns nothing usable. Rejections propagate. */
export async function generateSessionTitle(client: IModelClient, query: string, signal: AbortSignal): Promise<string | undefined> {
	const head = query.length > MAX_QUERY_CHARS ? query.slice(0, MAX_QUERY_CHARS) : query;
	let text = '';
	const stream = client.stream({
		system: TITLE_SYSTEM,
		messages: [{ role: 'user', content: [{ type: 'text', text: head }] }],
		tools: [],
		signal,
	});
	for await (const event of stream) {
		if (event.type === 'text_delta') {
			text += event.text;
		}
	}
	return sanitizeSessionTitle(text);
}
