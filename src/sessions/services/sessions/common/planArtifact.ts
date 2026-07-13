/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared logic for the `propose_plan` artifact: parsing the model's raw tool
 * input, materializing it into an IPlanArtifact (ids and version are assigned
 * HERE, deterministically — the model never sees ids), and rendering the
 * markdown fallback that rides the message's `text` for older builds and the
 * next run's transcript.
 */

import type { IPlanArtifact, IPlanComment, IPlanSection } from './session.js';

export const PLAN_SECTION_KINDS: readonly IPlanSection['kind'][] = ['overview', 'files', 'approach', 'steps', 'risks'];

/** What the model sends `propose_plan` — no ids, no version, no state. */
export interface IProposePlanSectionInput {
	readonly kind: IPlanSection['kind'];
	readonly heading: string;
	readonly body?: string;
	readonly items?: readonly string[];
}
export interface IProposePlanInput {
	readonly title: string;
	readonly sections: readonly IProposePlanSectionInput[];
}

/** Validate the model's raw input; returns undefined (never throws) on shape mismatch. */
export function parsePlanInput(input: unknown): IProposePlanInput | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	if (typeof record.title !== 'string' || record.title.trim() === '' || !Array.isArray(record.sections) || record.sections.length === 0) {
		return undefined;
	}
	const sections: IProposePlanSectionInput[] = [];
	for (const raw of record.sections) {
		if (typeof raw !== 'object' || raw === null) {
			return undefined;
		}
		const section = raw as Record<string, unknown>;
		if (!PLAN_SECTION_KINDS.includes(section.kind as IPlanSection['kind']) || typeof section.heading !== 'string' || section.heading.trim() === '') {
			return undefined;
		}
		if (section.body !== undefined && typeof section.body !== 'string') {
			return undefined;
		}
		if (section.items !== undefined && (!Array.isArray(section.items) || section.items.some(item => typeof item !== 'string'))) {
			return undefined;
		}
		sections.push({
			kind: section.kind as IPlanSection['kind'],
			heading: section.heading,
			...(section.body !== undefined ? { body: section.body } : {}),
			...(section.items !== undefined ? { items: section.items as string[] } : {}),
		});
	}
	return { title: record.title, sections };
}

/** Build the artifact from validated input. Section ids are deterministic (`${planId}-s${index}`). */
export function materializePlan(input: IProposePlanInput, planId: string, version: number): IPlanArtifact {
	return {
		id: planId,
		version,
		title: input.title,
		state: 'draft',
		sections: input.sections.map((section, index) => ({
			id: `${planId}-s${index}`,
			kind: section.kind,
			heading: section.heading,
			body: section.body ?? '',
			...(section.items !== undefined ? { items: section.items } : {}),
		})),
	};
}

/** Markdown fallback: what older builds render, and what the next run's transcript carries. */
export function planToMarkdown(plan: IPlanArtifact): string {
	const lines: string[] = [`## 实现方案 v${plan.version}: ${plan.title}`];
	for (const section of plan.sections) {
		lines.push('', `### ${section.heading}`);
		if (section.body.trim() !== '') {
			lines.push('', section.body);
		}
		if (section.items !== undefined && section.items.length > 0) {
			lines.push('', ...section.items.map(item => `- ${item}`));
		}
	}
	return lines.join('\n');
}

/**
 * Assemble the revise turn from a plan's OPEN comments: what the model sees
 * when the user clicks 让它改. Comments are quoted with their section heading
 * (the model never saw section ids). Returns undefined when nothing is open —
 * the caller falls back to focusing the composer.
 */
export function buildReviseTurn(plan: IPlanArtifact, comments: readonly IPlanComment[]): string | undefined {
	const open = comments.filter(comment => comment.planId === plan.id && !comment.resolved);
	if (open.length === 0) {
		return undefined;
	}
	const heading = (sectionId: string): string => plan.sections.find(section => section.id === sectionId)?.heading ?? '方案';
	const lines = [
		`我评审了实现方案 v${plan.version},段落批注如下:`,
		...open.map(comment => `- [${heading(comment.sectionId)}] ${comment.body}`),
		'请据此修订,并重新调用 propose_plan 给出新版本。',
	];
	return lines.join('\n');
}

/** The next plan version in this session: 1 + the highest version already present. */
export function nextPlanVersion(messages: readonly { readonly plan?: IPlanArtifact }[]): number {
	let max = 0;
	for (const message of messages) {
		if (message.plan !== undefined && message.plan.version > max) {
			max = message.plan.version;
		}
	}
	return max + 1;
}
