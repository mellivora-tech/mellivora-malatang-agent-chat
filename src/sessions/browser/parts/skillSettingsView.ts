/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import type { ISkill } from '../../services/skills/common/skills.js';
import { settingsButton, settingsSection } from './settingsControls.js';

/**
 * Settings › Skills: the list of reusable instruction snippets plus an inline
 * editor (name, description, body). A skill is attached to a message with
 * `$name` in the composer; its body rides that run's system prompt.
 */
export class SkillSettingsView extends Disposable {
	readonly element: HTMLElement;

	/** The skill being edited, 'new' for a fresh one, or undefined (list only). */
	private editing: ISkill | 'new' | undefined;
	private error: string | undefined;

	constructor(private readonly skillsService: ISkillsService) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'sessions-settings-page';
		this._register(this.skillsService.skills.subscribe(() => this.render()));
		this.render();
	}

	private render(): void {
		clearNode(this.element);

		const title = append(this.element, document.createElement('h2'));
		title.className = 'sessions-settings-page-title';
		title.textContent = 'Skills';

		const intro = append(this.element, document.createElement('p'));
		intro.className = 'sessions-settings-page-intro';
		intro.textContent = 'Reusable instruction snippets. Attach one to a message by typing $ in the composer; its body is added to that run’s instructions.';

		const skills = this.skillsService.skills.get();
		const card = settingsSection(this.element, skills.length === 0 ? undefined : 'Your skills');

		if (skills.length === 0 && this.editing === undefined) {
			const empty = append(card, document.createElement('div'));
			empty.className = 'sessions-skills-empty';
			empty.textContent = 'No skills yet.';
		}

		for (const skill of skills) {
			if (this.editing !== 'new' && this.editing?.id === skill.id) {
				this.renderEditor(card, skill);
				continue;
			}
			const row = append(card, document.createElement('div'));
			row.className = 'sessions-settings-row';
			const text = append(row, document.createElement('div'));
			text.className = 'sessions-settings-row-text';
			const name = append(text, document.createElement('div'));
			name.className = 'sessions-settings-row-title';
			name.textContent = `${skill.name} ($${skill.id})`;
			if (skill.description) {
				const description = append(text, document.createElement('div'));
				description.className = 'sessions-settings-row-desc';
				description.textContent = skill.description;
			}
			const controls = append(row, document.createElement('div'));
			controls.className = 'sessions-settings-row-control';
			settingsButton(controls, 'Edit', () => {
				this.editing = skill;
				this.error = undefined;
				this.render();
			});
			settingsButton(controls, 'Delete', () => {
				void this.skillsService.deleteSkill(skill.id);
			});
		}

		if (this.editing === 'new') {
			this.renderEditor(card, undefined);
		} else if (this.editing === undefined) {
			const actions = append(this.element, document.createElement('div'));
			actions.className = 'sessions-skills-actions';
			settingsButton(actions, 'Add skill', () => {
				this.editing = 'new';
				this.error = undefined;
				this.render();
			});
		}
	}

	private renderEditor(card: HTMLElement, skill: ISkill | undefined): void {
		const editor = append(card, document.createElement('div'));
		editor.className = 'sessions-skills-editor';

		const nameInput = append(editor, document.createElement('input')) as HTMLInputElement;
		nameInput.className = 'sessions-skills-input';
		nameInput.placeholder = 'Name (e.g. Commit style)';
		nameInput.value = skill?.name ?? '';

		const descriptionInput = append(editor, document.createElement('input')) as HTMLInputElement;
		descriptionInput.className = 'sessions-skills-input';
		descriptionInput.placeholder = 'One-line description (shown in the $ picker)';
		descriptionInput.value = skill?.description ?? '';

		const bodyInput = append(editor, document.createElement('textarea')) as HTMLTextAreaElement;
		bodyInput.className = 'sessions-skills-body';
		bodyInput.placeholder = 'Instructions the agent should follow when this skill is attached…';
		bodyInput.rows = 8;
		bodyInput.value = skill?.body ?? '';

		if (this.error) {
			const error = append(editor, document.createElement('div'));
			error.className = 'sessions-skills-error';
			error.setAttribute('role', 'alert');
			error.textContent = this.error;
		}

		const actions = append(editor, document.createElement('div'));
		actions.className = 'sessions-skills-actions';
		settingsButton(actions, 'Save', () => {
			void this.skillsService
				.upsertSkill({ ...(skill ? { id: skill.id } : {}), name: nameInput.value, description: descriptionInput.value, body: bodyInput.value })
				.then(() => {
					this.editing = undefined;
					this.error = undefined;
					this.render();
				})
				.catch(error => {
					this.error = error instanceof Error ? error.message : String(error);
					this.render();
				});
		});
		settingsButton(actions, 'Cancel', () => {
			this.editing = undefined;
			this.error = undefined;
			this.render();
		});

		nameInput.focus();
	}
}
