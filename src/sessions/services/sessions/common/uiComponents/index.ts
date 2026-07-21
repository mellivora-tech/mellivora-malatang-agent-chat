/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The component vocabulary for `render_ui` cards, shared between the main
 * process (tool schema enum + validateInput) and the renderer (the visual
 * registry in agentUi/registry.ts keys off the same names). Adding a component
 * type means: a props parser listed here, a React component registered in the
 * renderer — and nothing else (no new role, no storage or agent-loop changes).
 *
 * MUST stay grid-free: unit tests import this under bare `node --test`, so
 * nothing here may (transitively) import React, Tabulator, or CSS.
 */

import { generateDslPrompt } from '../../../../common/uiDsl/catalog.js';
import { explainSurfacePatchProps, parseSurfacePatchProps } from './surfacePatch.js';

/**
 * A props validator: returns the parsed, trusted props on success, undefined
 * on any shape/cap violation. Never throws — the caller turns undefined into
 * a corrective tool error for the model.
 */
export type UiPropsValidator = (props: unknown) => unknown | undefined;

export const UI_COMPONENT_VALIDATORS: Readonly<Record<string, UiPropsValidator>> = {
	surface_patch: parseSurfacePatchProps,
};

/**
 * Optional per-component rejection detail: when a validator refuses, the tool
 * appends this explanation so the model can self-correct against STRUCTURED
 * errors instead of guessing (#12 M4 — the DSL's parser hints ride this).
 */
export const UI_COMPONENT_ERROR_EXPLAINERS: Readonly<Record<string, (props: unknown) => string | undefined>> = {
	surface_patch: explainSurfacePatchProps,
};

export const UI_COMPONENT_NAMES: readonly string[] = Object.keys(UI_COMPONENT_VALIDATORS);

/**
 * Model-facing usage guidance per component, folded into the render_ui tool
 * description — teaching a new card's calling convention lives HERE, next to
 * its validator, never in the tool itself.
 */
export const UI_COMPONENT_GUIDANCE: Readonly<Record<string, string>> = {
	surface_patch:
		'surface_patch — patch the session WORKBENCH SURFACE (a persistent panel beside the chat) with a batch of line-DSL statements. ' +
		'Use it for multi-step working UIs (filter panels, previews the user iterates on); a later call PATCHES the same surface — resend only changed/new statements, never the whole program. ' +
		'References may point at statements from earlier batches; declare `root = ...` in the FIRST batch only (redeclare it only to change the layout). ' +
		'props: { surface? (id, default "main"), statements (the DSL text; must lint clean — errors come back structured) }.\n' +
		'--- DSL reference ---\n' +
		generateDslPrompt() +
		'\n--- end DSL reference ---',
};
