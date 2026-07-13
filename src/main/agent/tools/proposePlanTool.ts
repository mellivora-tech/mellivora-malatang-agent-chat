/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PLAN_SECTION_KINDS, parsePlanInput } from '../../../sessions/services/sessions/common/planArtifact.js';
import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { invalid, valid } from './workspace.js';

/**
 * The Implementation-Plan meta-tool: the model proposes a SECTIONED plan the
 * user reviews before execution. Distinct from `update_plan` (the running
 * progress checklist) — both exist, they are different artifacts. The call has
 * no side effect here; the renderer materializes the structured input from the
 * tool_use event and persists it as a `role:'plan'` message. The echo is a
 * one-line confirmation so the model doesn't restate the plan in prose.
 */
export function createProposePlanTool(): IAgentTool {
	return defineTool({
		name: 'propose_plan',
		description:
			'Propose a sectioned implementation plan for the user to review before any code is written: which files change, the approach, the steps, the risks. The plan is shown to the user as a reviewable card — after calling this, close with ONE short sentence; do not restate the plan in prose. If the user left comments on a section, revise and call propose_plan again (a new version).',
		inputSchema: {
			type: 'object',
			properties: {
				title: { type: 'string', description: 'One-line summary of what the plan achieves.' },
				sections: {
					type: 'array',
					description: 'The plan, in sections. Typical order: overview, files, approach, steps, risks.',
					items: {
						type: 'object',
						properties: {
							kind: { type: 'string', enum: [...PLAN_SECTION_KINDS] },
							heading: { type: 'string' },
							body: { type: 'string', description: 'Markdown prose for this section.' },
							items: { type: 'array', items: { type: 'string' }, description: 'Bullet items (best for files / steps).' },
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
			return parsed ? valid(parsed) : invalid(`input needs a non-empty "title" and a non-empty "sections" array; each section needs a "kind" (${PLAN_SECTION_KINDS.join('/')}) and a non-empty "heading"`);
		},
		call: async input => {
			const plan = input as { readonly title: string; readonly sections: readonly unknown[] };
			return { content: `Plan recorded: "${plan.title}" (${plan.sections.length} sections). It is now shown to the user for review — close with one short sentence and stop.` };
		},
	});
}
