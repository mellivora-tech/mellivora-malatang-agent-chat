/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Type-only re-exports from the main-process git IPC (erased at runtime).
import type { IGitBranchesResult, IGitCheckoutResult } from '../../../../main/gitIpc.js';

export type { IGitBranchesResult, IGitCheckoutResult };

/** The shape exposed on `agentWindow.git` by the preload script. */
export interface IGitBridge {
	/** Current branch + local branches for a project's repository; undefined when not a git repo. */
	branches(projectId: string): Promise<IGitBranchesResult | undefined>;
	checkout(projectId: string, branch: string): Promise<IGitCheckoutResult>;
}
