/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IModelClient, IModelStreamEvent } from './agentTypes.js';

export type IScriptedEmission =
	{ readonly type: 'text'; readonly text: string } | { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: unknown };

/** One scripted assistant turn: the ordered blocks the "model" emits. */
export interface IScriptedTurn {
	readonly emit: readonly IScriptedEmission[];
}

/**
 * A deterministic {@link IModelClient} driven by a fixed script — one entry per
 * turn. It ignores the request, so it is only for tests and local demos; the
 * real Claude / GLM client reads `request.messages` and streams from the API.
 * Its `stopReason` is `tool_use` when the turn emits a tool call, else `end_turn`.
 */
export function createScriptedModelClient(turns: readonly IScriptedTurn[]): IModelClient {
	let index = 0;

	return {
		async *stream(): AsyncGenerator<IModelStreamEvent, void> {
			const turn = turns[index];
			index += 1;

			if (!turn) {
				yield { type: 'message_stop', stopReason: 'end_turn' };
				return;
			}

			let emittedToolUse = false;
			for (const emission of turn.emit) {
				if (emission.type === 'text') {
					yield { type: 'text_delta', text: emission.text };
				} else {
					emittedToolUse = true;
					yield { type: 'tool_use', block: { type: 'tool_use', id: emission.id, name: emission.name, input: emission.input } };
				}
			}

			yield { type: 'message_stop', stopReason: emittedToolUse ? 'tool_use' : 'end_turn' };
		},
	};
}
