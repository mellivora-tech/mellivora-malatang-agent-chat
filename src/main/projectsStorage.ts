/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { CodeRootVcs, ICodeRootView, IProject, IProjectInput, IRemoteRepo, IRemoteRepoInput, IRemoteRepoView } from '../sessions/services/projects/common/projects.js';
import { cloneOrUpdate, gitRemoteOrigin, normalizeRepoUrl, repoName, runCommand, type CommandRunner } from './repoClone.js';
import { scanRepos } from './repoScan.js';

export type { IProject, IProjectInput } from '../sessions/services/projects/common/projects.js';

export function resolveDataRoot(env: NodeJS.ProcessEnv, homedir: string): string {
	const override = env['MELLIVORA_DATA_DIR'];
	return override ? override : join(homedir, '.mellivora');
}

export async function ensureProjectsRoot(root: string): Promise<void> {
	await mkdir(getProjectsDir(root), { recursive: true });
}

export async function listProjects(root: string): Promise<readonly IProject[]> {
	let entries;
	try {
		entries = await readdir(getProjectsDir(root), { withFileTypes: true });
	} catch (error) {
		if (getErrnoCode(error) === 'ENOENT') {
			return [];
		}
		throw error;
	}

	const projects: IProject[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}

		const project = await readProject(root, entry.name);
		if (project) {
			projects.push(project);
		}
	}

	return projects.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function getProject(root: string, id: string): Promise<IProject | undefined> {
	return readProject(root, id);
}

export async function createProject(root: string, input: IProjectInput): Promise<IProject> {
	const projectsDir = getProjectsDir(root);
	await mkdir(projectsDir, { recursive: true });

	for (;;) {
		const id = randomUUID().slice(0, 8);
		try {
			// Non-recursive mkdir throws EEXIST, making the id claim atomic
			// against concurrent creates.
			await mkdir(join(projectsDir, id));
		} catch (error) {
			if (getErrnoCode(error) === 'EEXIST') {
				continue;
			}
			throw error;
		}

		const project: IProject = {
			id,
			name: input.name,
			path: resolve(input.path),
			createdAt: new Date().toISOString(),
		};
		const file = join(projectsDir, id, 'project.json');
		await writeFile(`${file}.tmp`, `${JSON.stringify(project, undefined, '\t')}\n`, 'utf8');
		await rename(`${file}.tmp`, file);
		return project;
	}
}

/**
 * Delete a project: remove its app-managed dir (project.json, sessions, cloned
 * remotes). External code roots and the workspace's own `.mellivora` config are
 * the user's files and are left untouched.
 */
export async function deleteProject(root: string, projectId: string): Promise<void> {
	await rm(join(getProjectsDir(root), projectId), { recursive: true, force: true });
}

export async function ensureProject(root: string, input: IProjectInput): Promise<IProject> {
	const targetPath = resolve(input.path);
	const existing = (await listProjects(root)).find(project => project.path === targetPath);
	return existing ?? createProject(root, input);
}

function getProjectsDir(root: string): string {
	return join(root, 'projects');
}

async function readProject(root: string, id: string): Promise<IProject | undefined> {
	let raw: string;
	try {
		raw = await readFile(join(getProjectsDir(root), id, 'project.json'), 'utf8');
	} catch {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}

	if (!isProject(parsed) || parsed.id !== id) {
		return undefined;
	}

	const candidate = parsed as IProject & Record<string, unknown>;
	// Only surface the new fields when the file actually carries them. Legacy
	// single-folder projects stay byte-identical (path is the implicit workspace);
	// consumers fall back with `workspacePath ?? path` (see projectCodeRoots).
	const workspacePath = typeof candidate.workspacePath === 'string' && candidate.workspacePath.length > 0 ? candidate.workspacePath : undefined;
	// Preserve an empty codeRoots array (it means "already seeded, nothing kept"),
	// distinct from an ABSENT field (never seeded — see ensureCodeRootsSeeded).
	const codeRoots = Array.isArray(candidate.codeRoots) ? candidate.codeRoots.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : undefined;
	const remotes = Array.isArray(candidate.remotes) ? candidate.remotes.map(parseRemote).filter((entry): entry is IRemoteRepo => entry !== undefined) : undefined;
	return {
		id: parsed.id,
		name: parsed.name,
		path: parsed.path,
		createdAt: parsed.createdAt,
		...(workspacePath ? { workspacePath } : {}),
		...(codeRoots !== undefined ? { codeRoots } : {}),
		...(remotes && remotes.length > 0 ? { remotes } : {}),
	};
}

async function writeProject(root: string, project: IProject): Promise<void> {
	const file = join(getProjectsDir(root), project.id, 'project.json');
	await writeFile(`${file}.tmp`, `${JSON.stringify(project, undefined, '\t')}\n`, 'utf8');
	await rename(`${file}.tmp`, file);
}

/** Detect whether a path is a git/svn working copy (presence of a `.git` / `.svn` entry). */
export async function detectVcs(path: string): Promise<CodeRootVcs | undefined> {
	for (const [marker, vcs] of [['.git', 'git'] as const, ['.svn', 'svn'] as const]) {
		try {
			await stat(join(path, marker));
			return vcs;
		} catch {
			// Marker absent — try the next.
		}
	}
	return undefined;
}

/** Add a code root (deduped, absolute) to the project. Returns the new code-root list. */
export async function addCodeRoot(root: string, projectId: string, path: string): Promise<readonly string[]> {
	const project = await readProject(root, projectId);
	if (!project) {
		return [];
	}
	const resolved = resolve(path);
	const current = project.codeRoots ?? [];
	if (current.includes(resolved)) {
		return current;
	}
	const next = [...current, resolved];
	await writeProject(root, { ...project, codeRoots: next });
	return next;
}

/** Remove a code root from the project. Returns the new code-root list. */
export async function removeCodeRoot(root: string, projectId: string, path: string): Promise<readonly string[]> {
	const project = await readProject(root, projectId);
	if (!project) {
		return [];
	}
	const next = (project.codeRoots ?? []).filter(candidate => candidate !== path);
	await writeProject(root, { ...project, codeRoots: next });
	return next;
}

/**
 * On a project's FIRST touch of the code page (codeRoots absent), scan its
 * workspace for repos and seed them as code roots. Writing the array (even
 * empty) marks the project seeded, so later user removals are never re-added.
 */
export async function ensureCodeRootsSeeded(root: string, projectId: string): Promise<void> {
	const project = await readProject(root, projectId);
	if (!project || project.codeRoots !== undefined) {
		return;
	}
	const workspace = project.workspacePath ?? project.path;
	// The workspace is the project home — repos sit at it or a few levels under.
	const repos = workspace ? await scanRepos(workspace, { maxDepth: 3 }) : [];
	await writeProject(root, { ...project, codeRoots: repos.map(repo => repo.path) });
}

/** The project's explicit code roots, each annotated with its detected VCS (for the config UI). */
export async function listCodeRoots(root: string, projectId: string): Promise<readonly ICodeRootView[]> {
	const project = await readProject(root, projectId);
	const views: ICodeRootView[] = [];
	for (const path of project?.codeRoots ?? []) {
		const vcs = await detectVcs(path);
		views.push({ path, name: basename(path), ...(vcs ? { vcs } : {}) });
	}
	return views;
}

// --- remote repositories -----------------------------------------------------

function remotesDir(root: string, projectId: string): string {
	// Hidden (`.repos`) so the workspace/discover repo scans — which skip dotdirs —
	// never surface a cloned remote as if it were a local repo.
	return join(getProjectsDir(root), projectId, '.repos');
}

/** Deterministic, per-project clone location for a remote (keyed by its stable id). */
export function remoteLocalPath(root: string, projectId: string, remoteId: string): string {
	return join(remotesDir(root, projectId), remoteId);
}

function parseRemote(value: unknown): IRemoteRepo | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const candidate = value as Record<string, unknown>;
	if (typeof candidate['id'] !== 'string' || typeof candidate['url'] !== 'string' || typeof candidate['name'] !== 'string') {
		return undefined;
	}
	const vcs: CodeRootVcs = candidate['vcs'] === 'svn' ? 'svn' : 'git';
	return {
		id: candidate['id'],
		url: candidate['url'],
		name: candidate['name'],
		vcs,
		...(typeof candidate['ref'] === 'string' && candidate['ref'].length > 0 ? { ref: candidate['ref'] } : {}),
	};
}

/**
 * Register a remote repo. Deduped by NORMALIZED url against existing remotes AND
 * against local code roots (a git root whose `origin` is the same repo) — so the
 * same repo is never pulled in twice. A duplicate throws with an explanation.
 * `run` is injectable for tests.
 */
export async function addRemote(root: string, projectId: string, input: IRemoteRepoInput, run: CommandRunner = runCommand): Promise<readonly IRemoteRepo[]> {
	const project = await readProject(root, projectId);
	if (!project) {
		return [];
	}
	const url = input.url.trim();
	const current = project.remotes ?? [];
	if (url === '') {
		return current;
	}
	const key = normalizeRepoUrl(url);
	if (current.some(remote => normalizeRepoUrl(remote.url) === key)) {
		throw new Error('该远程仓库已添加。');
	}
	const signal = new AbortController().signal;
	for (const codeRoot of project.codeRoots ?? []) {
		const origin = await gitRemoteOrigin(codeRoot, signal, run);
		if (origin && normalizeRepoUrl(origin) === key) {
			throw new Error(`该仓库已作为本地代码存在(${basename(codeRoot)}),无需添加为远程。`);
		}
	}
	const remote: IRemoteRepo = {
		id: `repo-${randomUUID().slice(0, 8)}`,
		url,
		vcs: input.vcs === 'svn' ? 'svn' : 'git',
		name: repoName(url),
		...(input.ref && input.ref.trim() ? { ref: input.ref.trim() } : {}),
	};
	const next = [...current, remote];
	await writeProject(root, { ...project, remotes: next });
	return next;
}

/** Remove a remote and delete its clone from disk. */
export async function removeRemote(root: string, projectId: string, remoteId: string): Promise<readonly IRemoteRepo[]> {
	const project = await readProject(root, projectId);
	if (!project) {
		return [];
	}
	const next = (project.remotes ?? []).filter(remote => remote.id !== remoteId);
	await writeProject(root, { ...project, remotes: next });
	await rm(remoteLocalPath(root, projectId, remoteId), { recursive: true, force: true });
	return next;
}

async function remoteView(root: string, projectId: string, remote: IRemoteRepo): Promise<IRemoteRepoView> {
	const localPath = remoteLocalPath(root, projectId, remote.id);
	const marker = remote.vcs === 'svn' ? '.svn' : '.git';
	let cloned = false;
	try {
		await stat(join(localPath, marker));
		cloned = true;
	} catch {
		// Not cloned yet.
	}
	return { ...remote, localPath, cloned };
}

export async function listRemotes(root: string, projectId: string): Promise<readonly IRemoteRepoView[]> {
	const project = await readProject(root, projectId);
	return Promise.all((project?.remotes ?? []).map(remote => remoteView(root, projectId, remote)));
}

/** Clone or update one remote now. Returns the refreshed views. */
export async function cloneProjectRemote(root: string, projectId: string, remoteId: string, signal: AbortSignal): Promise<readonly IRemoteRepoView[]> {
	const project = await readProject(root, projectId);
	const remote = project?.remotes?.find(candidate => candidate.id === remoteId);
	if (remote) {
		const localPath = remoteLocalPath(root, projectId, remoteId);
		await mkdir(remotesDir(root, projectId), { recursive: true });
		await cloneOrUpdate(localPath, remote, signal);
	}
	return listRemotes(root, projectId);
}

/**
 * Ensure every remote is on disk (clone the missing ones), best-effort. Returns
 * the local paths that are ready to use as code roots. Called at run start —
 * a clone failure just omits that remote rather than failing the whole run.
 */
export async function ensureRemotesCloned(root: string, projectId: string, signal: AbortSignal): Promise<readonly string[]> {
	const project = await readProject(root, projectId);
	const ready: string[] = [];
	for (const remote of project?.remotes ?? []) {
		const view = await remoteView(root, projectId, remote);
		if (view.cloned) {
			ready.push(view.localPath);
			continue;
		}
		await mkdir(remotesDir(root, projectId), { recursive: true });
		const result = await cloneOrUpdate(view.localPath, remote, signal);
		if (result.ok) {
			ready.push(view.localPath);
		}
	}
	return ready;
}

/** The paths the agent's file tools should scope to: explicit codeRoots, or the workspace/path as the implicit single root. */
export function projectCodeRoots(project: IProject): readonly string[] {
	if (project.codeRoots && project.codeRoots.length > 0) {
		return project.codeRoots;
	}
	const fallback = project.workspacePath ?? project.path;
	return fallback ? [fallback] : [];
}

function isProject(value: unknown): value is IProject {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	const candidate = value as Record<string, unknown>;
	return typeof candidate['id'] === 'string' && typeof candidate['name'] === 'string' && typeof candidate['path'] === 'string' && typeof candidate['createdAt'] === 'string';
}

function getErrnoCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}
