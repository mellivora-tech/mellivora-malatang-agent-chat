/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ISkill, ISkillInput } from '../sessions/services/skills/common/skills.js';

/**
 * Skills are reusable instruction snippets the user attaches to a message with
 * `$name`; the body rides the run's system prompt. One markdown file per skill
 * under `dataRoot/skills/`, human-editable:
 *
 *   ---
 *   name: Commit style
 *   description: How to write commits in this repo
 *   ---
 *   body…
 *
 * The filename (sans .md) is the stable id — renaming a skill keeps its id, so
 * `$mentions` recorded in old sessions keep resolving.
 */

function skillsDir(root: string): string {
	return join(root, 'skills');
}

function skillFilePath(root: string, id: string): string {
	return join(skillsDir(root), `${id}.md`);
}

/** ids are slugs: lowercase, hyphenated, filesystem- and mention-safe. */
export function slugifySkillName(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9一-鿿]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug === '' ? 'skill' : slug;
}

/** Serialize with the frontmatter header; `\r\n` is normalized on parse, not here. */
function serializeSkill(skill: { name: string; description: string; body: string }): string {
	return `---\nname: ${skill.name.replace(/\n/g, ' ')}\ndescription: ${skill.description.replace(/\n/g, ' ')}\n---\n\n${skill.body}\n`;
}

/** Parse one skill file; tolerant of a missing frontmatter block (whole file = body, name = id). */
export function parseSkillFile(id: string, raw: string): ISkill {
	const normalized = raw.replace(/\r\n/g, '\n');
	const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
	let name = id;
	let description = '';
	let body = normalized;
	if (match) {
		body = normalized.slice(match[0].length).replace(/^\n/, '');
		for (const line of match[1]!.split('\n')) {
			const colon = line.indexOf(':');
			if (colon === -1) {
				continue;
			}
			const key = line.slice(0, colon).trim();
			const value = line.slice(colon + 1).trim();
			if (key === 'name' && value !== '') {
				name = value;
			} else if (key === 'description') {
				description = value;
			}
		}
	}
	return { id, name, description, body: body.replace(/\n$/, '') };
}

export async function listSkills(root: string): Promise<readonly ISkill[]> {
	let entries;
	try {
		entries = await readdir(skillsDir(root), { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: ISkill[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.md')) {
			continue;
		}
		const id = entry.name.slice(0, -3);
		try {
			skills.push(parseSkillFile(id, await readFile(skillFilePath(root, id), 'utf8')));
		} catch {
			// A single unreadable file must not hide the rest.
		}
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSkill(root: string, id: string): Promise<ISkill | undefined> {
	// ids come back over IPC — never let one traverse out of the skills dir.
	if (!/^[a-z0-9一-鿿-]+$/.test(id)) {
		return undefined;
	}
	try {
		return parseSkillFile(id, await readFile(skillFilePath(root, id), 'utf8'));
	} catch {
		return undefined;
	}
}

export async function upsertSkill(root: string, input: ISkillInput): Promise<ISkill> {
	const name = input.name.trim();
	if (name === '') {
		throw new Error('A skill needs a name.');
	}
	await mkdir(skillsDir(root), { recursive: true });

	let id = input.id;
	if (!id) {
		// New skill: derive the id from the name, uniquified against existing files.
		const base = slugifySkillName(name);
		id = base;
		const existing = new Set((await listSkills(root)).map(skill => skill.id));
		for (let counter = 2; existing.has(id); counter++) {
			id = `${base}-${counter}`;
		}
	} else if ((await getSkill(root, id)) === undefined) {
		throw new Error(`Unknown skill: ${id}`);
	}

	const skill: ISkill = { id, name, description: input.description.trim(), body: input.body.replace(/\r\n/g, '\n').trim() };
	await writeFile(skillFilePath(root, id), serializeSkill(skill), 'utf8');
	return skill;
}

export async function deleteSkill(root: string, id: string): Promise<void> {
	if ((await getSkill(root, id)) !== undefined) {
		await rm(skillFilePath(root, id), { force: true });
	}
}

/** The system-prompt block for one attached skill (projectInstructions pattern). */
export function formatSkillBlock(skill: ISkill): string {
	return `<skill name="${skill.name}">\nThe user attached this skill — follow its instructions where relevant.\n${skill.body}\n</skill>`;
}
