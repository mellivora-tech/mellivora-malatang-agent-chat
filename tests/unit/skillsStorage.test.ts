/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deleteSkill, formatSkillBlock, getSkill, listSkills, parseSkillFile, slugifySkillName, upsertSkill } from '../../src/main/skillsStorage.js';

async function createTempRoot(): Promise<string> {
	return mkdtemp(join(tmpdir(), 'agent-chat-skills-'));
}

test('upsertSkill create/list/get/delete round-trip', async () => {
	const root = await createTempRoot();
	try {
		const created = await upsertSkill(root, { name: 'Commit style', description: 'How to write commits', body: 'Use imperative mood.' });
		assert.equal(created.id, 'commit-style');

		const listed = await listSkills(root);
		assert.equal(listed.length, 1);
		assert.deepEqual(listed[0], created);

		const edited = await upsertSkill(root, { id: created.id, name: 'Commit style v2', description: 'Updated', body: 'New body.' });
		assert.equal(edited.id, 'commit-style', 'editing keeps the id stable even when the name changes');
		assert.equal((await getSkill(root, 'commit-style'))?.name, 'Commit style v2');

		await deleteSkill(root, created.id);
		assert.equal((await listSkills(root)).length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('creating a second skill with a colliding name uniquifies the id', async () => {
	const root = await createTempRoot();
	try {
		await upsertSkill(root, { name: 'Review', description: '', body: 'a' });
		const second = await upsertSkill(root, { name: 'review', description: '', body: 'b' });
		assert.equal(second.id, 'review-2');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('upsertSkill rejects an empty name and an unknown edit id', async () => {
	const root = await createTempRoot();
	try {
		await assert.rejects(upsertSkill(root, { name: '  ', description: '', body: 'x' }), /needs a name/);
		await assert.rejects(upsertSkill(root, { id: 'ghost', name: 'Ghost', description: '', body: 'x' }), /Unknown skill/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('getSkill refuses ids that could traverse out of the skills dir', async () => {
	const root = await createTempRoot();
	try {
		assert.equal(await getSkill(root, '../models'), undefined);
		assert.equal(await getSkill(root, 'a/b'), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('parseSkillFile tolerates a file with no frontmatter', () => {
	const skill = parseSkillFile('raw-notes', 'Just a body\nwith two lines');
	assert.equal(skill.name, 'raw-notes');
	assert.equal(skill.description, '');
	assert.equal(skill.body, 'Just a body\nwith two lines');
});

test('listSkills skips non-md files and survives hand-edited content', async () => {
	const root = await createTempRoot();
	try {
		await mkdir(join(root, 'skills'), { recursive: true });
		await writeFile(join(root, 'skills', 'hand-made.md'), '---\nname: Hand made\ndescription: edited in vim\n---\n\nBody here\n', 'utf8');
		await writeFile(join(root, 'skills', 'notes.txt'), 'not a skill', 'utf8');

		const skills = await listSkills(root);
		assert.equal(skills.length, 1);
		assert.deepEqual(skills[0], { id: 'hand-made', name: 'Hand made', description: 'edited in vim', body: 'Body here' });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('slugify and formatSkillBlock shape', () => {
	assert.equal(slugifySkillName('Commit Style!!'), 'commit-style');
	assert.equal(slugifySkillName('提交规范'), '提交规范');
	assert.equal(slugifySkillName('***'), 'skill');

	const block = formatSkillBlock({ id: 'x', name: 'X', description: '', body: 'Do the thing.' });
	assert.match(block, /^<skill name="X">/);
	assert.match(block, /Do the thing\./);
	assert.match(block, /<\/skill>$/);
});
