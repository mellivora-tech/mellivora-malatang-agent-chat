/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineTool } from '../agentTools.js';
import type { IAgentTool } from '../agentTypes.js';
import { asRecord, invalid, valid } from './workspace.js';

type StepStatus = 'pending' | 'active' | 'done';
const STATUSES: readonly StepStatus[] = ['pending', 'active', 'done'];
const MARK: Readonly<Record<StepStatus, string>> = { pending: '[ ]', active: '[~]', done: '[x]' };

interface IPlanStep {
	readonly title: string;
	readonly status: StepStatus;
}

/**
 * A meta-tool (no filesystem or process effect) that lets the model keep a short
 * finite checklist for the current task. Its whole value is organizing the
 * model's own process — declaring "these are the things to do", working them one
 * at a time, and stopping when they are all done, instead of exploring without
 * bound. The tool just echoes the rendered plan back so it stays in view.
 */
export function createUpdatePlanTool(): IAgentTool {
	return defineTool({
		name: 'update_plan',
		description:
			'Maintain a short checklist for a multi-step task. Call it first to lay out the steps, then again to update statuses as you go. Keep it small (a handful of steps), mark one step "active" at a time, and once every step is "done", stop and give your final answer — do not keep exploring.',
		inputSchema: {
			type: 'object',
			properties: {
				steps: {
					type: 'array',
					description: 'The full checklist (send the whole list each time).',
					items: {
						type: 'object',
						properties: {
							title: { type: 'string' },
							status: { type: 'string', enum: STATUSES },
						},
						required: ['title', 'status'],
						additionalProperties: false,
					},
				},
			},
			required: ['steps'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record || !Array.isArray(record.steps)) {
				return invalid('"steps" must be an array');
			}
			for (const step of record.steps) {
				const stepRecord = asRecord(step);
				if (!stepRecord || typeof stepRecord.title !== 'string' || stepRecord.title === '') {
					return invalid('each step needs a non-empty "title"');
				}
				if (!STATUSES.includes(stepRecord.status as StepStatus)) {
					return invalid(`each step "status" must be one of ${STATUSES.join(', ')}`);
				}
			}
			return valid(record);
		},
		call: async input => {
			const { steps } = input as { steps: readonly IPlanStep[] };
			if (steps.length === 0) {
				return { content: 'Plan cleared.' };
			}
			const rendered = steps.map(step => `${MARK[step.status]} ${step.title}`).join('\n');
			const done = steps.filter(step => step.status === 'done').length;
			const footer = done === steps.length ? '\n\nAll steps done — stop and give your final answer.' : '';
			return { content: `Plan (${done}/${steps.length} done):\n${rendered}${footer}` };
		},
	});
}
