/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
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
		input.placeholder = 'Ask Mellivora anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations';
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

const LATE_NIGHT_TAILS: readonly string[] = [
	'都几点了还不睡，肝是钢做的？',
	'这个点了，是真爱还是真上头',
	'别的都睡了，就咱俩醒着，说吧',
	'熬夜冠军在此，说说肝到几点',
	'凌晨了，兄弟，命是自己的',
];

/** The landing heading's time-of-day half, each paired with a pool of tails riffing on what that hour actually feels like — not a generic joke recycled all day. */
const GREETING_BUCKETS: readonly { readonly maxHour: number; readonly label: string; readonly tails: readonly string[] }[] = [
	{ maxHour: 5, label: '凌晨好', tails: LATE_NIGHT_TAILS },
	{
		maxHour: 11,
		label: '早上好',
		tails: [
			'起来了？人醒了，魂还没归位，说吧',
			'早八人状态：肉身到岗，灵魂在床上',
			'闹钟响了八百遍，人来了，说需求',
			'咖啡还没下肚，先凑合听我说',
			'打工人集合，说说今天惹了什么活',
		],
	},
	{
		maxHour: 13,
		label: '中午好',
		tails: ['饭点了，先别摸鱼，说说你想干啥', '干饭魂干饭魄，说完事儿再睡午觉', '困是真困，但活是真的要干', '摸鱼一时爽，一直摸一直爽，说吧', '中午了，效率约等于零，但还是听你说'],
	},
	{
		maxHour: 18,
		label: '下午好',
		tails: ['困成🐶了，但还是硬扛着听你说', '下午三点魂飞天，说说你想干啥', '下午茶都没喝上，先说说你要干啥', '打工人还有几个小时就解放了，抓紧说', '工位上装忙，其实在等你发需求'],
	},
	{
		maxHour: 23,
		label: '晚上好',
		tails: ['别人下班了，我们还在肝，说吧', '晚上好，卷王模式已启动', '下班了？不存在的，继续肝', '夜深了，代码和秃头更配哦', '有事快说，说完我要去摸鱼了'],
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
