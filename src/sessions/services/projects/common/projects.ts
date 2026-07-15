/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IProject {
	readonly id: string;
	readonly name: string;
	/** Legacy single folder — retained as the back-compat alias of {@link workspacePath}; existing consumers still read it. */
	readonly path: string;
	readonly createdAt: string;
	/** The project's home dir: holds the workspace config (.mellivora/) and may hold code. Defaults to {@link path} for projects created before the system-project model. */
	readonly workspacePath?: string;
	/** Code locations the agent's file tools operate on; each may be inside the workspace or an external absolute path. Empty ⇒ fall back to the workspace/path. */
	readonly codeRoots?: readonly string[];
	/** Remote repositories cloned to a managed dir and used as code roots at run time. */
	readonly remotes?: readonly IRemoteRepo[];
}

export interface IProjectInput {
	readonly name: string;
	readonly path: string;
}

export type CodeRootVcs = 'git' | 'svn';

/** A repository found by the discovery scan (a candidate to add as a code root). */
export interface IDiscoveredRepo {
	readonly path: string;
	readonly name: string;
	readonly vcs: CodeRootVcs;
}

/** An explicit code root the project already tracks, annotated with its detected VCS. */
export interface ICodeRootView {
	readonly path: string;
	readonly name: string;
	readonly vcs?: CodeRootVcs;
}

/** A remote repository the project pulls in — cloned to a managed dir and used as a code root at run time. */
export interface IRemoteRepo {
	readonly id: string;
	readonly url: string;
	readonly vcs: CodeRootVcs;
	readonly name: string;
	/** Branch/tag to check out; the default branch when absent. */
	readonly ref?: string;
}

/** The remote as the renderer sees it: definition + where it clones to + whether it's on disk. */
export interface IRemoteRepoView extends IRemoteRepo {
	readonly localPath: string;
	readonly cloned: boolean;
}

/** Add payload for a remote; vcs defaults to git, name is derived from the URL. */
export interface IRemoteRepoInput {
	readonly url: string;
	readonly vcs?: CodeRootVcs;
	readonly ref?: string;
}

/**
 * The shape exposed on `agentWindow.projects` by the preload script. Pure data
 * contract shared between the main process and the renderer.
 */
export interface IProjectsBridge {
	list(): Promise<readonly IProject[]>;
	create(input: IProjectInput): Promise<IProject>;
	pickAndCreate(): Promise<IProject | undefined>;
	/** Delete the project (its app-managed dir); external code is untouched. */
	deleteProject(projectId: string): Promise<void>;
	/** Open the project directory in the OS file manager. */
	revealInFolder(projectId: string): Promise<boolean>;
	/** Workspace-relative file paths under the project root (capped), for the composer's @-mention picker. */
	listFiles?(projectId: string): Promise<readonly string[]>;
	/** The project's tracked code roots, annotated with detected VCS. */
	listCodeRoots(projectId: string): Promise<readonly ICodeRootView[]>;
	/** Scan for git/svn repositories under `scanRoot` (defaults to the user's home) to offer as code roots. */
	discoverRepos(projectId: string, scanRoot?: string): Promise<readonly IDiscoveredRepo[]>;
	/** Add a code root by absolute path; returns the refreshed annotated list. */
	addCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]>;
	/** Remove a code root; returns the refreshed annotated list. */
	removeCodeRoot(projectId: string, path: string): Promise<readonly ICodeRootView[]>;
	/** Open a folder picker and add the chosen directory as a code root; returns the refreshed list (undefined if cancelled). */
	pickCodeRoot(projectId: string): Promise<readonly ICodeRootView[] | undefined>;
	/** The project's remote repositories, each with its clone location + on-disk state. */
	listRemotes(projectId: string): Promise<readonly IRemoteRepoView[]>;
	/** Persisted "always allow" patterns for this project (bash: only). */
	listApprovalAllowlist(projectId: string): Promise<readonly string[]>;
	/** Revoke one persisted pattern; resolves to the remaining list. */
	removeApprovalAllowPattern(projectId: string, pattern: string): Promise<readonly string[]>;
	/** Register a remote repo (cloned lazily at run time / on demand); returns the refreshed list. */
	addRemote(projectId: string, input: IRemoteRepoInput): Promise<readonly IRemoteRepoView[]>;
	/** Remove a remote and delete its clone; returns the refreshed list. */
	removeRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]>;
	/** Clone or update a remote now; returns the refreshed list (state reflects the outcome). */
	cloneRemote(projectId: string, remoteId: string): Promise<readonly IRemoteRepoView[]>;
}
