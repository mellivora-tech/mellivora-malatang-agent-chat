/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import test from 'node:test';

import type { IProject, IProjectInput, IProjectsBridge } from '../../src/sessions/services/projects/common/projects.js';
import { ProjectsService } from '../../src/sessions/services/projects/browser/projectsService.js';

function createProject(id: string, name: string): IProject {
	return { id, name, path: `/tmp/${name}`, createdAt: '2026-07-06T00:00:00.000Z' };
}

function createBridge(options: { projects?: IProject[]; picked?: IProject | undefined } = {}): IProjectsBridge & { createCalls: IProjectInput[] } {
	const projects = options.projects ?? [];
	const createCalls: IProjectInput[] = [];
	return {
		createCalls,
		list: async () => [...projects],
		create: async (input: IProjectInput) => {
			createCalls.push(input);
			const project = createProject(`id-${createCalls.length}`, input.name);
			projects.push(project);
			return project;
		},
		pickAndCreate: async () => {
			if (options.picked) {
				projects.push(options.picked);
			}
			return options.picked;
		},
	};
}

test('initialize loads projects and defaults the active project to the first', async () => {
	const alpha = createProject('aaaa1111', 'alpha');
	const beta = createProject('bbbb2222', 'beta');
	const service = new ProjectsService(createBridge({ projects: [alpha, beta] }));

	await service.initialize();

	assert.deepEqual(service.projects.get(), [alpha, beta]);
	assert.deepEqual(service.activeProject.get(), alpha);
});

test('initialize with no bridge leaves the service empty', async () => {
	const service = new ProjectsService(undefined);

	await service.initialize();

	assert.deepEqual(service.projects.get(), []);
	assert.equal(service.activeProject.get(), undefined);
});

test('setActiveProject switches the active project', async () => {
	const alpha = createProject('aaaa1111', 'alpha');
	const beta = createProject('bbbb2222', 'beta');
	const service = new ProjectsService(createBridge({ projects: [alpha, beta] }));
	await service.initialize();

	service.setActiveProject('bbbb2222');

	assert.deepEqual(service.activeProject.get(), beta);
});

test('setActiveProject ignores unknown ids', async () => {
	const alpha = createProject('aaaa1111', 'alpha');
	const service = new ProjectsService(createBridge({ projects: [alpha] }));
	await service.initialize();

	service.setActiveProject('missing');

	assert.deepEqual(service.activeProject.get(), alpha);
});

test('addProjectViaDialog refreshes the list and activates the new project', async () => {
	const alpha = createProject('aaaa1111', 'alpha');
	const picked = createProject('cccc3333', 'picked');
	const service = new ProjectsService(createBridge({ projects: [alpha], picked }));
	await service.initialize();

	const added = await service.addProjectViaDialog();

	assert.deepEqual(added, picked);
	assert.deepEqual(service.projects.get(), [alpha, picked]);
	assert.deepEqual(service.activeProject.get(), picked);
});

test('addProjectViaDialog keeps state when the dialog is cancelled', async () => {
	const alpha = createProject('aaaa1111', 'alpha');
	const service = new ProjectsService(createBridge({ projects: [alpha] }));
	await service.initialize();

	const added = await service.addProjectViaDialog();

	assert.equal(added, undefined);
	assert.deepEqual(service.projects.get(), [alpha]);
	assert.deepEqual(service.activeProject.get(), alpha);
});
