/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IModelClient } from './agentTypes.js';

/**
 * The reply verifier is the answer-side counterpart of the loop guard: a
 * post-submission check that the final reply actually addresses the user's
 * message. Modeled on Claude Code's Stop hook architecture (check on stop →
 * feed rejection back as a hidden user message → force one continuation,
 * guarded against loops); the judgment itself is a built-in LLM call, which
 * this harness adds because its target failure — a model-side stochastic
 * decode fault that leaves the visible reply answering a hallucinated
 * question — was investigated to exhaustion and cannot be fixed at the
 * source (byte-faithful replay of the failing request: 0/10 reproduction).
 *
 * Fail-open by design: a judge that errors, times out, or answers something
 * unparseable must never harm a normal reply.
 */
const MAX_QUESTION_CHARS = 2000;
const MAX_ANSWER_CHARS = 4000;

const JUDGE_SYSTEM = [
	"You review whether an assistant's reply addresses the user's message.",
	'A reply that asks a relevant clarifying question, explains why the question cannot be answered, or requests missing information DOES address the message.',
	'Answer NO only when the reply talks about a different topic than what the user asked.',
	'First line: exactly YES or NO. Second line: one short reason.',
].join('\n');

export type ReplyVerdict = 'pass' | 'fail' | 'error';

export interface IReplyVerification {
	readonly verdict: ReplyVerdict;
	readonly reason: string;
}

/** Kill switch: MELLIVORA_REPLY_VERIFIER=off (same pattern as the loop guard). */
export function isReplyVerifierEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['MELLIVORA_REPLY_VERIFIER'] !== 'off';
}

/** One cheap, tool-less judge call through the same model client. */
export async function verifyReply(input: { client: IModelClient; question: string; answer: string; signal: AbortSignal }): Promise<IReplyVerification> {
	const question = input.question.slice(0, MAX_QUESTION_CHARS);
	const answer = input.answer.slice(0, MAX_ANSWER_CHARS);

	let text = '';
	try {
		const stream = input.client.stream({
			system: JUDGE_SYSTEM,
			messages: [
				{
					role: 'user',
					content: [{ type: 'text', text: `User's message:\n${question}\n\nAssistant's reply:\n${answer}\n\nDoes the reply address the user's message?` }],
				},
			],
			tools: [],
			signal: input.signal,
		});
		for await (const event of stream) {
			if (event.type === 'text_delta') {
				text += event.text;
			}
		}
	} catch (error) {
		return { verdict: 'error', reason: error instanceof Error ? error.message : String(error) };
	}

	return parseVerdict(text);
}

/** First meaningful line decides; anything else is a judge malfunction → 'error' (treated as pass). */
export function parseVerdict(text: string): IReplyVerification {
	const lines = text
		.split('\n')
		.map(line => line.trim())
		.filter(line => line !== '');
	const first = lines[0] ?? '';
	const reason = lines.slice(1).join(' ').trim();
	if (/^yes\b/i.test(first)) {
		return { verdict: 'pass', reason };
	}
	if (/^no\b/i.test(first)) {
		return { verdict: 'fail', reason: reason || first };
	}
	return { verdict: 'error', reason: `unparseable judge output: ${text.slice(0, 120)}` };
}

/** The hidden feedback message that forces the single retry (CC: "Stop hook feedback"). */
export function buildRetryFeedback(question: string, reason: string): string {
	return (
		`Reply verifier: your previous reply did not address the user's actual message. The user asked:\n` +
		`"${question.slice(0, MAX_QUESTION_CHARS)}"\n` +
		`Answer that question directly now.${reason ? ` Reviewer's note: ${reason}` : ''}`
	);
}
