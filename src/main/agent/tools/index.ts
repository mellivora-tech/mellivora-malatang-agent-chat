/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { UI_COMPONENT_NAMES } from '../../../sessions/services/sessions/common/uiComponents/index.js';
import type { IAgentTool } from '../agentTypes.js';
import type { ILanguageServerManager } from '../lsp/languageServerManager.js';
import { createBashTool } from './bashTool.js';
import { createEditFileTool } from './editFileTool.js';
import { createGlobTool } from './globTool.js';
import { createGrepTool } from './grepTool.js';
import { createListDirTool } from './listDirTool.js';
import { createProposePlanTool } from './proposePlanTool.js';
import { createReadFileTool } from './readFileTool.js';
import { createReadSymbolTool } from './readSymbolTool.js';
import { createRememberFactTool } from './rememberFactTool.js';
import { createRenderUiTool } from './renderUiTool.js';
import { createUpdatePlanTool } from './updatePlanTool.js';
import { createWalkthroughTool } from './walkthroughTool.js';
import { createWriteFileTool } from './writeFileTool.js';

export interface IWorkspaceToolsOptions {
	/**
	 * Include file-mutating tools (write_file / edit_file / bash). These run behind
	 * the permission gate — the gate for the session's mode decides whether they
	 * execute, ask for approval, or are denied (plan mode omits them entirely).
	 */
	readonly includeMutations?: boolean;
	/**
	 * When provided, adds the read-only `read_symbol` tool backed by this language
	 * server manager. Omitted → no symbol tool (the manager owns process lifecycle,
	 * so it is created once per run and threaded in, not spun up per tool set).
	 */
	readonly languageServers?: ILanguageServerManager;
}

/**
 * Build the tool set bound to the project's code roots (`roots`, non-empty;
 * `roots[0]` is the primary — relative paths and bash's cwd resolve there).
 * File tools accept a path inside ANY root and refuse to escape all of them.
 * bash is NOT sandboxed (it can run anything) — gates route it to approval.
 */
export function createWorkspaceTools(roots: readonly string[], options: IWorkspaceToolsOptions = {}): readonly IAgentTool[] {
	// update_plan, propose_plan, write_walkthrough and render_ui are meta-tools
	// (no side effects) available in every mode — the running checklist, the
	// reviewable implementation plan, the post-completion walkthrough, and the
	// generic interactive card respectively. render_ui only exists once at least
	// one component is registered — an empty enum in its schema would be junk.
	const readOnly = [
		createUpdatePlanTool(),
		createProposePlanTool(),
		createWalkthroughTool(),
		...(UI_COMPONENT_NAMES.length > 0 ? [createRenderUiTool()] : []),
		createReadFileTool(roots),
		createListDirTool(roots),
		createGlobTool(roots),
		createGrepTool(roots),
		...(options.languageServers ? [createReadSymbolTool({ roots, manager: options.languageServers })] : []),
		createRememberFactTool(),
	];
	if (!options.includeMutations) {
		return readOnly;
	}
	return [...readOnly, createWriteFileTool(roots), createEditFileTool(roots), createBashTool(roots)];
}
