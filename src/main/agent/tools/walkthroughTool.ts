/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PLAN_SECTION_KINDS, parsePlanInput } from '../../../sessions/services/sessions/common/planArtifact.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { invalid, valid } from './workspace.js';

/**
 * The Walkthrough meta-tool: after completing a task that changed files, the
 * model reports WHAT was done and HOW to verify it as a sectioned artifact —
 * the post-execution twin of `propose_plan`. No side effect here; the renderer
 * materializes the structured input from the tool_use event and persists it as
 * a settled (non-reviewable) plan message of kind 'walkthrough'.
 */
export function createWalkthroughTool(): IAgentTool {
	return defineTool({
		name: 'write_walkthrough',
		description:
			'After completing a multi-step task that changed files, record a sectioned walkthrough: what changed (files), what was done, and how to verify it (verify). Shown to the user as a card — after calling this, close with ONE short sentence; do not restate the walkthrough in prose. Skip it for trivial or read-only tasks.',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'One-line summary of what was accomplished.' },
				sections: {
					type: 'array',
					description: 'The walkthrough, in sections. Typical order: overview, files, verify.',
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: [...PLAN_SECTION_KINDS] },
							heading: { type: 'string' },
							body: { type: 'string', description: 'Markdown prose for this section.' },
							items: { type: 'array', items: { type: 'string' }, description: 'Bullet items (best for files / verify steps).' },
						},
						required: ['kind', 'heading'],
						additionalProperties: false,
					},
				},
			},
			required: ['title', 'sections'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		validateInput: input => {
			const parsed = parsePlanInput(input);
			return parsed
				? valid(parsed)
				: invalid(`input needs a non-empty "title" and a non-empty "sections" array; each section needs a "kind" (${PLAN_SECTION_KINDS.join('/')}) and a non-empty "heading"`);
		},
		call: async input => {
			const walkthrough = input as { readonly title: string; readonly sections: readonly unknown[] };
			return {
				content: `Walkthrough recorded: "${walkthrough.title}" (${walkthrough.sections.length} sections). It is now shown to the user — close with one short sentence and stop.`,
			};
		},
	});
}
