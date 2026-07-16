/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared logic for the `render_ui` artifact: parsing the model's raw tool
 * input, materializing it into an IUiArtifact (the id is assigned HERE — the
 * model never sees ids), and the markdown fallback that rides the message's
 * `text` for older builds and the next run's transcript.
 *
 * The generic envelope: the model picks a `component` from the registered
 * vocabulary (uiComponents/) and supplies its props; per-component shape/cap
 * validation is delegated to that component's own validator, so this file
 * never changes when a new component type is added.
 */

import type { IUiArtifact } from './session.js';
import { UI_COMPONENT_VALIDATORS } from './uiComponents/index.js';

/** Ceiling on JSON.stringify(props).length — structure and a small sample ride the card, never a full dataset. */
export const UI_PROPS_CHAR_CAP = 48_000;

/** What the model sends `render_ui` — no id. */
export interface IRenderUiInput {
	readonly component: string;
	readonly title: string;
	/**
	 * Model-authored markdown summary — required, non-empty. It is what older
	 * builds render, what an unknown/invalid component falls back to, AND what
	 * the model reads back in the next run's transcript (an empty assistant
	 * turn is an API error, so this can never be blank).
	 */
	readonly markdown: string;
	/** Component-specific payload; validated by the component's own parser. Must be JSON-round-trippable (bare JSON.stringify storage — no Dates). */
	readonly props: Record<string, unknown>;
}

/** Validate the model's raw input; returns undefined (never throws) on any shape, vocabulary, or cap violation. */
export function parseUiInput(input: unknown): IRenderUiInput | undefined {
	if (typeof input !== 'object' || input === null) {
		return undefined;
	}
	const record = input as Record<string, unknown>;
	if (
		typeof record.component !== 'string' ||
		typeof record.title !== 'string' ||
		record.title.trim() === '' ||
		typeof record.markdown !== 'string' ||
		record.markdown.trim() === ''
	) {
		return undefined;
	}
	if (typeof record.props !== 'object' || record.props === null || Array.isArray(record.props)) {
		return undefined;
	}
	if (JSON.stringify(record.props).length > UI_PROPS_CHAR_CAP) {
		return undefined;
	}
	const validator = UI_COMPONENT_VALIDATORS[record.component];
	if (validator === undefined || validator(record.props) === undefined) {
		return undefined;
	}
	return { component: record.component, title: record.title, markdown: record.markdown, props: record.props as Record<string, unknown> };
}

/** Build the artifact from validated input. The id is renderer-assigned. */
export function materializeUi(input: IRenderUiInput, uiId: string): IUiArtifact {
	return { id: uiId, component: input.component, title: input.title, props: input.props };
}

/** Markdown fallback: what older builds render, and what the next run's transcript carries. */
export function uiToMarkdown(input: IRenderUiInput): string {
	return `## ${input.title}\n\n${input.markdown}`;
}
