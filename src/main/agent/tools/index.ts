/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAgentTool } from '../agentTypes.js';
import { createGlobTool } from './globTool.js';
import { createGrepTool } from './grepTool.js';
import { createListDirTool } from './listDirTool.js';
import { createReadFileTool } from './readFileTool.js';

export interface IWorkspaceToolsOptions {
	/**
	 * Include file-mutating tools (write_file / edit_file / bash). These MUST run
	 * behind an approval gate — leave off until the composer's approval UI is wired,
	 * or the model can change files with no confirmation. Read-only tools only today.
	 */
	readonly includeMutations?: boolean;
}

/**
 * Build the tool set bound to a single workspace root (`cwd`). Every tool resolves
 * model-supplied paths against `cwd` and refuses to escape it.
 */
export function createWorkspaceTools(cwd: string, _options: IWorkspaceToolsOptions = {}): readonly IAgentTool[] {
	return [createReadFileTool(cwd), createListDirTool(cwd), createGlobTool(cwd), createGrepTool(cwd)];
}
