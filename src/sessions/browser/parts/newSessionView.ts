/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../common/i18n/i18n.js';
import { append } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { IModelsService } from '../../services/models/browser/modelsService.js';
import type { IProjectsService } from '../../services/projects/browser/projectsService.js';
import type { ISessionAttachment } from '../../services/sessions/common/session.js';
import type { IPendingImage } from '../../services/sessions/common/sessionsProvider.js';
import type { ISkillsService } from '../../services/skills/browser/skillsService.js';
import { installSlashCommands, TEMPLATE_COMMANDS, type IComposerCommand } from './composerCommands.js';
import { installImageAttachments } from './composerImages.js';
import { installFileMentions, installSessionMentions, installSkillMentions, type IEntityMentionEntry } from './composerMentions.js';
import { installEffortPicker, installModelPicker, installPermissionPicker } from './modelPicker.js';
import { greetingBucketLabel, pickGreeting } from './newSessionGreetings.js';

export interface INewSessionViewOptions {
	readonly onStartSession?: (query: string, attachments?: readonly ISessionAttachment[], images?: readonly IPendingImage[]) => Promise<unknown>;
	readonly projectsService?: IProjectsService;
	readonly modelsService?: IModelsService;
	readonly skillsService?: ISkillsService;
	/** Sessions offered by the #-mention picker, newest first. */
	readonly listSessions?: () => readonly IEntityMentionEntry[];
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
		let headingBucket = greetingBucketLabel(new Date().getHours());
		heading.textContent = pickGreeting(new Date().getHours());
		// Follow the clock: re-greet only when the hour crosses into a new bucket, so the tail doesn't churn within a time-of-day.
		const greetingTimer = setInterval(() => {
			const bucket = greetingBucketLabel(new Date().getHours());
			if (bucket !== headingBucket) {
				headingBucket = bucket;
				heading.textContent = pickGreeting(new Date().getHours());
			}
		}, 60_000);
		this._register(toDisposable(() => clearInterval(greetingTimer)));

		const composer = append(content, document.createElement('form')) as HTMLFormElement;
		composer.className = 'new-session-composer';

		const context = append(composer, document.createElement('button')) as HTMLButtonElement;
		context.className = 'new-session-composer-context';
		context.type = 'button';
		context.title = localize('ns.pickProject');
		const contextIcon = append(context, document.createElement('span'));
		contextIcon.className = 'codicon codicon-folder';
		contextIcon.setAttribute('aria-hidden', 'true');
		const contextLabel = append(context, document.createElement('span'));
		contextLabel.className = 'new-session-composer-context-label';
		contextLabel.textContent = localize('ns.pickProject');
		const contextChevron = append(context, document.createElement('span'));
		contextChevron.className = 'codicon codicon-chevron-down';
		contextChevron.setAttribute('aria-hidden', 'true');
		this.installProjectPicker(composer, context, contextLabel);

		const input = append(composer, document.createElement('textarea')) as HTMLTextAreaElement;
		input.className = 'new-session-input';
		input.rows = 2;
		input.placeholder = localize('ns.placeholder');
		input.spellcheck = true;

		// Installed before the Enter-to-send handler below — an Enter that picks
		// a mention must not also submit (at-target listeners run in order).
		const mentions = this._register(
			installFileMentions({
				host: content,
				input,
				loadPaths: () => {
					const project = this.options.projectsService?.activeProject.get();
					return project ? this.options.projectsService!.listProjectFiles(project.id) : undefined;
				},
			}),
		);
		const images = this._register(installImageAttachments({ input, dropTarget: composer, onDidChange: () => updateSendState() }));
		const skills = this._register(
			installSkillMentions({
				host: content,
				input,
				getSkills: () => this.options.skillsService?.skills.get() ?? [],
			}),
		);
		const sessionRefs = this._register(
			installSessionMentions({
				host: content,
				input,
				getSessions: () => this.options.listSessions?.() ?? [],
			}),
		);

		const toolbar = append(composer, document.createElement('div'));
		toolbar.className = 'new-session-composer-toolbar';

		const leftControls = append(toolbar, document.createElement('div'));
		leftControls.className = 'new-session-toolbar-left';

		const addButton = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		addButton.className = 'new-session-toolbar-button';
		addButton.type = 'button';
		addButton.title = localize('ns.attachImages');
		addButton.setAttribute('aria-label', localize('ns.attachImages'));
		const addIcon = append(addButton, document.createElement('span'));
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');
		addButton.addEventListener('click', () => images.pick());

		const access = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		access.className = 'new-session-access';
		access.type = 'button';
		access.title = localize('conv.approvals');
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
		model.title = localize('conv.pickModel');
		const modelIndicator = append(model, document.createElement('span'));
		modelIndicator.className = 'new-session-model-indicator';
		modelIndicator.setAttribute('aria-hidden', 'true');
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = localize('picker.noModel');
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
		sendButton.title = localize('ns.start');
		sendButton.setAttribute('aria-label', localize('ns.start'));
		const sendIcon = append(sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-arrow-up';
		sendIcon.setAttribute('aria-hidden', 'true');

		const updateSendState = () => {
			sendButton.disabled = input.value.trim().length === 0 && !images.hasImages();
		};
		input.addEventListener('input', updateSendState);
		updateSendState();

		// Registered after the pickers exist (their triggers back the action
		// commands) but before the Enter-to-send handler below, so a
		// command-picking Enter never also submits.
		const commands: IComposerCommand[] = [
			{ name: 'model', kind: 'action', description: 'Pick the model', run: () => model.click() },
			{ name: 'permission', kind: 'action', description: 'Pick the approval mode', run: () => access.click() },
			{ name: 'project', kind: 'action', description: 'Pick the project', run: () => context.click() },
			...TEMPLATE_COMMANDS,
		];
		this._register(installSlashCommands({ host: content, input, getCommands: () => commands }));

		composer.addEventListener('submit', event => {
			event.preventDefault();
			const query = input.value.trim();
			const pendingImages = images.getImages();
			if (!query && pendingImages.length === 0) {
				input.focus();
				return;
			}

			const attachments = [...mentions.collectAttachments(query), ...skills.collectAttachments(query), ...sessionRefs.collectAttachments(query)];
			input.value = '';
			mentions.reset();
			skills.reset();
			sessionRefs.reset();
			images.reset();
			updateSendState();
			void this.options.onStartSession?.(query, attachments.length > 0 ? attachments : undefined, pendingImages.length > 0 ? pendingImages : undefined);
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
				label.textContent = project?.name ?? localize('ns.pickProject');
				trigger.title = project ? `Project: ${project.path}` : 'Pick project';
			}),
		);
		label.textContent = projectsService.activeProject.get()?.name ?? localize('ns.pickProject');

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
			addLabel.textContent = localize('ns.addProject');
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
