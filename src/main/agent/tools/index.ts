/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTool } from '../agentTypes.js';
import { createBashTool } from './bashTool.js';
import { createEditFileTool } from './editFileTool.js';
import { createGlobTool } from './globTool.js';
import { createGrepTool } from './grepTool.js';
import { createListDirTool } from './listDirTool.js';
import { createProposePlanTool } from './proposePlanTool.js';
import { createReadFileTool } from './readFileTool.js';
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
}

/**
 * Build the tool set bound to the project's code roots (`roots`, non-empty;
 * `roots[0]` is the primary — relative paths and bash's cwd resolve there).
 * File tools accept a path inside ANY root and refuse to escape all of them.
 * bash is NOT sandboxed (it can run anything) — gates route it to approval.
 */
export function createWorkspaceTools(roots: readonly string[], options: IWorkspaceToolsOptions = {}): readonly IAgentTool[] {
	// update_plan, propose_plan and write_walkthrough are meta-tools (no side
	// effects) available in every mode — the running checklist, the reviewable
	// implementation plan, and the post-completion walkthrough respectively.
	const readOnly = [
		createUpdatePlanTool(),
		createProposePlanTool(),
		createWalkthroughTool(),
		createReadFileTool(roots),
		createListDirTool(roots),
		createGlobTool(roots),
		createGrepTool(roots),
	];
	if (!options.includeMutations) {
		return readOnly;
	}
	return [...readOnly, createWriteFileTool(roots), createEditFileTool(roots), createBashTool(roots)];
}
