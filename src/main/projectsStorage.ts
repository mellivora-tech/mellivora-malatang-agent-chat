/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IProject, IProjectInput } from '../sessions/services/projects/common/projects.js';

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
	const codeRoots = Array.isArray(candidate.codeRoots) ? candidate.codeRoots.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : undefined;
	return {
		id: parsed.id,
		name: parsed.name,
		path: parsed.path,
		createdAt: parsed.createdAt,
		...(workspacePath ? { workspacePath } : {}),
		...(codeRoots && codeRoots.length > 0 ? { codeRoots } : {}),
	};
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
