/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UI_PROPS_CHAR_CAP, parseUiInput } from '../../../sessions/services/sessions/common/uiArtifact.js';
import { UI_COMPONENT_ERROR_EXPLAINERS, UI_COMPONENT_GUIDANCE, UI_COMPONENT_NAMES } from '../../../sessions/services/sessions/common/uiComponents/index.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { invalid, valid } from './workspace.js';

/**
 * The generic interactive-card meta-tool: the model renders a structured,
 * interactive card in the conversation by picking a registered component and
 * supplying its props. Like propose_plan, the call has no side effect here —
 * the renderer materializes the structured input from the tool_use event and
 * persists it as a `role:'ui'` message. Adding a component type touches the
 * uiComponents vocabulary and the renderer registry, never this tool.
 */
export function createRenderUiTool(): IAgentTool {
	return defineTool({
		name: 'render_ui',
		description:
			'Render an interactive card in the conversation for content that deserves structure over prose — the user can inspect and act on it directly. ' +
			"The user's response (confirmation, corrections) comes back as a normal message. " +
			'After calling, close with ONE short sentence; do not restate the card content in prose. Components:\n' +
			UI_COMPONENT_NAMES.map(name => UI_COMPONENT_GUIDANCE[name] ?? name).join('\n'),
		inputSchema: {
			type: 'object',
			properties: {
				component: { type: 'string', enum: [...UI_COMPONENT_NAMES], description: 'Which registered card component to render.' },
				title: { type: 'string', description: 'Short card title shown in its header.' },
				markdown: {
					type: 'string',
					description:
						"Markdown fallback/summary — REQUIRED. Older builds render this instead of the card, and it is what YOU will see in the next turn's transcript, so summarize the proposal fully enough to act on it later.",
				},
				props: { type: 'object', description: "The component's own payload. Keep it small — structure and a bounded sample, never a full dataset." },
			},
			required: ['component', 'title', 'markdown', 'props'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		isConcurrencySafe: () => true,
		validateInput: input => {
			const parsed = parseUiInput(input);
			if (parsed) {
				return valid(parsed);
			}
			// Structured per-component detail when available (#12 M4): the DSL's
			// parser hints feed the model's self-correction directly.
			const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
			const explain = typeof record.component === 'string' ? UI_COMPONENT_ERROR_EXPLAINERS[record.component]?.(record.props) : undefined;
			return invalid(
				`input needs a registered "component" (${UI_COMPONENT_NAMES.join('/') || 'none available'}), a non-empty "title" and "markdown", and a "props" object matching that component's schema, at most ${UI_PROPS_CHAR_CAP} chars serialized — shrink the sample and shorten cell values if over` +
					(explain ? `\n${explain}` : ''),
			);
		},
		call: async input => {
			const card = input as { readonly component: string; readonly title: string };
			return { content: `UI card recorded: "${card.title}" (${card.component}). It is now shown to the user — close with one short sentence and stop.` };
		},
	});
}
