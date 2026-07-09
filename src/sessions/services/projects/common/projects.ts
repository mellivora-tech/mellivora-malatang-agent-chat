/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IProject {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly createdAt: string;
}

export interface IProjectInput {
	readonly name: string;
	readonly path: string;
}

/**
 * The shape exposed on `agentWindow.projects` by the preload script. Pure data
 * contract shared between the main process and the renderer.
 */
export interface IProjectsBridge {
	list(): Promise<readonly IProject[]>;
	create(input: IProjectInput): Promise<IProject>;
	pickAndCreate(): Promise<IProject | undefined>;
	/** Open the project directory in the OS file manager. */
	revealInFolder(projectId: string): Promise<boolean>;
}
