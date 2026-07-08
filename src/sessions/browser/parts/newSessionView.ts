/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';

export interface INewSessionViewOptions {
	readonly onStartSession?: (query: string) => Promise<unknown>;
	readonly projectsService?: IProjectsService;
	readonly modelsService?: IModelsService;
}

export class NewSessionView extends Disposable {
	readonly element: HTMLElement;

	constructor(private readonly options: INewSessionViewOptions = {}) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'sessions-new-session-view';

		const content = append(this.element, document.createElement('div'));
		content.className = 'new-session-content';

		const watermark = append(content, document.createElement('div'));
		watermark.className = 'new-session-watermark';
		watermark.setAttribute('aria-hidden', 'true');

		const heading = append(content, document.createElement('h1'));
		heading.className = 'new-session-heading';
		heading.textContent = 'Morning, how can I help?';

		const composer = append(content, document.createElement('form')) as HTMLFormElement;
		composer.className = 'new-session-composer';

		const context = append(composer, document.createElement('button')) as HTMLButtonElement;
		context.className = 'new-session-composer-context';
		context.type = 'button';
		context.title = 'Pick project';
		const contextIcon = append(context, document.createElement('span'));
		contextIcon.className = 'codicon codicon-folder';
		contextIcon.setAttribute('aria-hidden', 'true');
		const contextLabel = append(context, document.createElement('span'));
		contextLabel.className = 'new-session-composer-context-label';
		contextLabel.textContent = 'Select project';
		const contextChevron = append(context, document.createElement('span'));
		contextChevron.className = 'codicon codicon-chevron-down';
		contextChevron.setAttribute('aria-hidden', 'true');
		this.installProjectPicker(composer, context, contextLabel);

		const input = append(composer, document.createElement('textarea')) as HTMLTextAreaElement;
		input.className = 'new-session-input';
		input.rows = 2;
		input.placeholder = 'Ask ZCode anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations';
		input.spellcheck = true;

		const toolbar = append(composer, document.createElement('div'));
		toolbar.className = 'new-session-composer-toolbar';

		const leftControls = append(toolbar, document.createElement('div'));
		leftControls.className = 'new-session-toolbar-left';

		const addButton = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		addButton.className = 'new-session-toolbar-button';
		addButton.type = 'button';
		addButton.title = 'Add context';
		addButton.setAttribute('aria-label', 'Add context');
		const addIcon = append(addButton, document.createElement('span'));
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');

		const access = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		access.className = 'new-session-access';
		access.type = 'button';
		access.title = 'Approvals';
		const accessIcon = append(access, document.createElement('span'));
		accessIcon.className = 'codicon codicon-shield';
		accessIcon.setAttribute('aria-hidden', 'true');
		const accessLabel = append(access, document.createElement('span'));
		const accessChevron = append(access, document.createElement('span'));
		accessChevron.className = 'codicon codicon-chevron-down';
		accessChevron.setAttribute('aria-hidden', 'true');
		// Menu hosted on `content` — the composer clips overflow.
		this._register(installPermissionPicker({ host: content, trigger: access, label: accessLabel, icon: accessIcon }));

		const rightControls = append(toolbar, document.createElement('div'));
		rightControls.className = 'new-session-toolbar-right';

		const model = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		model.className = 'new-session-model';
		model.type = 'button';
		model.title = 'Pick model';
		const modelIndicator = append(model, document.createElement('span'));
		modelIndicator.className = 'new-session-model-indicator';
		modelIndicator.setAttribute('aria-hidden', 'true');
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = 'No model';
		const modelChevron = append(model, document.createElement('span'));
		modelChevron.className = 'codicon codicon-chevron-down';
		modelChevron.setAttribute('aria-hidden', 'true');
		if (this.options.modelsService) {
			// Host the menu outside the composer, which clips overflow.
			this._register(installModelPicker({ host: content, trigger: model, label: modelLabel, modelsService: this.options.modelsService }));
		}

		const effort = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		effort.className = 'new-session-effort';
		effort.type = 'button';
		effort.hidden = true;
		const effortLabel = append(effort, document.createElement('span'));
		const effortChevron = append(effort, document.createElement('span'));
		effortChevron.className = 'codicon codicon-chevron-down';
		effortChevron.setAttribute('aria-hidden', 'true');
		if (this.options.modelsService) {
			this._register(installEffortPicker({ host: content, trigger: effort, label: effortLabel, modelsService: this.options.modelsService }));
		}

		const sendButton = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		sendButton.className = 'new-session-send-button';
		sendButton.type = 'submit';
		sendButton.title = 'Start session';
		sendButton.setAttribute('aria-label', 'Start session');
		const sendIcon = append(sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-arrow-up';
		sendIcon.setAttribute('aria-hidden', 'true');

		composer.addEventListener('submit', event => {
			event.preventDefault();
			const query = input.value.trim();
			if (!query) {
				input.focus();
				return;
			}

			input.value = '';
			void this.options.onStartSession?.(query);
		});

		input.addEventListener('keydown', event => {
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) {
				return;
			}

			event.preventDefault();
			composer.requestSubmit();
		});
	}

	private installProjectPicker(composer: HTMLElement, trigger: HTMLButtonElement, label: HTMLElement): void {
		const projectsService = this.options.projectsService;
		if (!projectsService) {
			return;
		}

		this._register(
			projectsService.activeProject.subscribe(project => {
				label.textContent = project?.name ?? 'Select project';
				trigger.title = project ? `Project: ${project.path}` : 'Pick project';
			}),
		);
		label.textContent = projectsService.activeProject.get()?.name ?? 'Select project';

		let menu: HTMLElement | undefined;

		const closeMenu = () => {
			menu?.remove();
			menu = undefined;
			document.removeEventListener('mousedown', onOutsideMouseDown, true);
			document.removeEventListener('keydown', onEscape, true);
		};

		const onOutsideMouseDown = (event: MouseEvent) => {
			if (menu && event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) {
				closeMenu();
			}
		};

		const onEscape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				closeMenu();
			}
		};

		const openMenu = () => {
			// Host the menu outside the composer, which clips overflow.
			const host = composer.parentElement ?? composer;
			menu = append(host, document.createElement('div'));
			menu.className = 'new-session-project-menu';
			menu.setAttribute('role', 'menu');
			const hostRect = host.getBoundingClientRect();
			const triggerRect = trigger.getBoundingClientRect();
			menu.style.top = `${triggerRect.bottom - hostRect.top + 4}px`;
			menu.style.left = `${triggerRect.left - hostRect.left}px`;

			const activeProjectId = projectsService.activeProject.get()?.id;
			for (const project of projectsService.projects.get()) {
				const item = append(menu, document.createElement('button')) as HTMLButtonElement;
				item.className = 'new-session-project-item';
				item.type = 'button';
				item.setAttribute('role', 'menuitem');
				item.title = project.path;
				const check = append(item, document.createElement('span'));
				check.className = `codicon codicon-check${project.id === activeProjectId ? '' : ' project-check-hidden'}`;
				check.setAttribute('aria-hidden', 'true');
				const name = append(item, document.createElement('span'));
				name.className = 'new-session-project-item-label';
				name.textContent = project.name;
				item.addEventListener('click', () => {
					projectsService.setActiveProject(project.id);
					closeMenu();
				});
			}

			if (projectsService.projects.get().length > 0) {
				const separator = append(menu, document.createElement('div'));
				separator.className = 'new-session-project-menu-separator';
			}

			const addItem = append(menu, document.createElement('button')) as HTMLButtonElement;
			addItem.className = 'new-session-project-item new-session-project-add';
			addItem.type = 'button';
			addItem.setAttribute('role', 'menuitem');
			const addIcon = append(addItem, document.createElement('span'));
			addIcon.className = 'codicon codicon-add';
			addIcon.setAttribute('aria-hidden', 'true');
			const addLabel = append(addItem, document.createElement('span'));
			addLabel.className = 'new-session-project-item-label';
			addLabel.textContent = 'Add project…';
			addItem.addEventListener('click', () => {
				closeMenu();
				void projectsService.addProjectViaDialog();
			});

			document.addEventListener('mousedown', onOutsideMouseDown, true);
			document.addEventListener('keydown', onEscape, true);
		};

		trigger.addEventListener('click', () => {
			if (menu) {
				closeMenu();
			} else {
				openMenu();
			}
		});

		this._register(toDisposable(closeMenu));
	}
}
