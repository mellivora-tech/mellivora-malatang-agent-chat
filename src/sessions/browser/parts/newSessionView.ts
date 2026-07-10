/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
		let headingBucket = greetingBucket(new Date().getHours());
		heading.textContent = pickGreeting(new Date().getHours());
		// Follow the clock: re-greet only when the hour crosses into a new bucket, so the tail doesn't churn within a time-of-day.
		const greetingTimer = setInterval(() => {
			const bucket = greetingBucket(new Date().getHours());
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
		input.placeholder = 'Ask Mellivora anything, @ for files, / for commands, $ for skills, # for related conversations, paste or drop images';
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
		const images = this._register(installImageAttachments({ input, dropTarget: composer }));
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
		addButton.title = 'Attach images';
		addButton.setAttribute('aria-label', 'Attach images');
		const addIcon = append(addButton, document.createElement('span'));
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');
		addButton.addEventListener('click', () => images.pick());

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
			if (!query) {
				input.focus();
				return;
			}

			const attachments = [...mentions.collectAttachments(query), ...skills.collectAttachments(query), ...sessionRefs.collectAttachments(query)];
			const pendingImages = images.getImages();
			input.value = '';
			mentions.reset();
			skills.reset();
			sessionRefs.reset();
			images.reset();
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

const LATE_NIGHT_TAILS: readonly string[] = [
	'凌晨的班加了，凌晨的钱一分没见',
	'你在拉磨，老板在睡觉，这就是分工',
	'猝死名单在排队，你这是在插队',
	'这个点干活，图啥？图老板换新车吗',
	'命是自己的，磨是老板的，掂量掂量',
];

/** The landing heading's time-of-day half, each paired with a pool of 牛马 tails — bitter about the system, never about the user; dark humor keeps the floor. */
const GREETING_BUCKETS: readonly { readonly maxHour: number; readonly label: string; readonly tails: readonly string[] }[] = [
	{ maxHour: 5, label: '凌晨好', tails: LATE_NIGHT_TAILS },
	{
		maxHour: 11,
		label: '早上好',
		tails: [
			'打卡机不认人，只认牛马',
			'又是替老板圆梦的一天',
			'通勤两小时，上班如上坟，说吧',
			'晨会画的饼，够你饿一天',
			'太阳照常升起，工资照常不涨',
		],
	},
	{
		maxHour: 13,
		label: '中午好',
		tails: ['吃快点，磨不等牛', '午饭是成本，你也是成本', '这顿外卖，是你今天唯一的福利', '午休二十分钟，资本家已经觉得亏了', '嚼着预制菜，干着预制的人生'],
	},
	{
		maxHour: 18,
		label: '下午好',
		tails: ['下午三点，灵魂已死，肉体营业', 'KPI 不会疼你，我也只能听你说说', '你困不困老板不管，磨停没停他真管', '咖啡续不动命了，那就续需求吧', '再撑三小时，回棚吃草'],
	},
	{
		maxHour: 23,
		label: '晚上好',
		tails: ['下班是违章行为，加班是企业文化', '你加的每一个班，都是老板游艇的一块板', '晚上十点，灯火通明，全是不敢走的', '工资是月抛的，健康是一次性的', '这个点还在干，明天老板夸你两句，就两句'],
	},
	{ maxHour: 24, label: '凌晨好', tails: LATE_NIGHT_TAILS },
];

function greetingBucket(hour: number): (typeof GREETING_BUCKETS)[number] {
	return GREETING_BUCKETS.find(candidate => hour < candidate.maxHour) ?? GREETING_BUCKETS[GREETING_BUCKETS.length - 1]!;
}

/** e.g. "下午好，下午三点魂飞天，说说你想干啥" — the greeting for this exact hour, tail picked fresh each time the view mounts or the clock enters a new bucket. */
function pickGreeting(hour: number): string {
	const bucket = greetingBucket(hour);
	const tail = bucket.tails[Math.floor(Math.random() * bucket.tails.length)]!;
	return `${bucket.label}，${tail}`;
}
