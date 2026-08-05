/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionRunner, type IAction, type IActionRunner, type IRunEvent } from '../../../common/actions.js';
import { Emitter, type Event } from '../../../common/event.js';
import { Disposable, DisposableStore } from '../../../common/lifecycle.js';
import { reportFailure } from '../../../../common/diagnostics.js';

export interface IActionViewItem {
	readonly action: IAction;
	readonly element: HTMLElement;
	setActionContext(context: unknown): void;
	render(container: HTMLElement): void;
	isEnabled(): boolean;
	focus(): void;
	blur(): void;
	dispose(): void;
}

export interface IActionViewItemProvider {
	(action: IAction): IActionViewItem | undefined;
}

export const enum ActionsOrientation {
	HORIZONTAL,
	VERTICAL,
}

export interface IActionBarOptions {
	readonly orientation?: ActionsOrientation;
	readonly context?: unknown;
	readonly actionViewItemProvider?: IActionViewItemProvider;
	readonly actionRunner?: IActionRunner;
	readonly ariaLabel?: string;
	readonly ariaRole?: string;
}

export interface IActionOptions {
	readonly index?: number;
}

export class ActionBar extends Disposable implements IActionRunner {
	private readonly actionRunner: IActionRunner;
	private readonly actionRunnerDisposables = this._register(new DisposableStore());
	private readonly viewItemDisposables = this._register(new DisposableStore());
	private readonly viewItems: IActionViewItem[] = [];
	private context: unknown;

	readonly domNode: HTMLElement;
	private readonly actionsList: HTMLUListElement;

	private readonly onDidRunEmitter = this._register(new Emitter<IRunEvent>());
	private readonly onWillRunEmitter = this._register(new Emitter<IRunEvent>());

	readonly onDidRun: Event<IRunEvent> = this.onDidRunEmitter.event;
	readonly onWillRun: Event<IRunEvent> = this.onWillRunEmitter.event;

	constructor(
		container: HTMLElement,
		private readonly options: IActionBarOptions = {},
	) {
		super();

		this.context = options.context ?? null;
		this.actionRunner = options.actionRunner ?? this.actionRunnerDisposables.add(new ActionRunner());
		this.actionRunnerDisposables.add(this.actionRunner.onDidRun(event => this.onDidRunEmitter.fire(event)));
		this.actionRunnerDisposables.add(this.actionRunner.onWillRun(event => this.onWillRunEmitter.fire(event)));

		this.domNode = document.createElement('div');
		this.domNode.className = 'monaco-action-bar';
		if (options.orientation === ActionsOrientation.VERTICAL) {
			this.domNode.classList.add('vertical');
		}

		this.actionsList = document.createElement('ul');
		this.actionsList.className = 'actions-container';
		this.actionsList.setAttribute('role', options.ariaRole ?? 'toolbar');
		if (options.ariaLabel) {
			this.actionsList.setAttribute('aria-label', options.ariaLabel);
		}
		this.domNode.appendChild(this.actionsList);
		container.appendChild(this.domNode);
	}

	async run(action: IAction, context?: unknown): Promise<void> {
		await this.actionRunner.run(action, context);
	}

	push(action: IAction, options: IActionOptions = {}): IActionViewItem {
		const item = document.createElement('li');
		item.className = 'action-item';
		item.setAttribute('role', 'presentation');

		const viewItem = this.options.actionViewItemProvider?.(action) ?? new ActionViewItem(this.context, action, this);
		viewItem.render(item);

		const index = typeof options.index === 'number' ? options.index : this.actionsList.children.length;
		const before = this.actionsList.children.item(index);
		this.actionsList.insertBefore(item, before);
		this.viewItems.splice(index, 0, viewItem);
		this.viewItemDisposables.add(viewItem);

		return viewItem;
	}

	clear(): void {
		this.viewItems.length = 0;
		this.viewItemDisposables.clear();
		this.actionsList.replaceChildren();
	}

	setActionContext(context: unknown): void {
		this.context = context;
		for (const viewItem of this.viewItems) {
			viewItem.setActionContext(context);
		}
	}
}

export class ActionViewItem extends Disposable implements IActionViewItem {
	readonly element = document.createElement('a');
	private context: unknown;
	private rendered = false;

	constructor(
		context: unknown,
		readonly action: IAction,
		private readonly actionRunner: IActionRunner,
	) {
		super();
		this.context = context;
	}

	render(container: HTMLElement): void {
		if (this.rendered) {
			return;
		}
		this.rendered = true;
		this.element.className = this.getActionLabelClass();
		this.element.href = '#';
		this.element.setAttribute('role', 'button');
		this.element.tabIndex = -1;
		this.updateEnabled();
		this.updateTooltip();
		this.renderLabel();

		this.element.addEventListener('click', event => {
			event.preventDefault();
			event.stopPropagation();
			void this.run();
		});
		this.element.addEventListener('keydown', event => {
			if (event.key !== 'Enter' && event.key !== ' ') {
				return;
			}

			event.preventDefault();
			event.stopPropagation();
			void this.run();
		});

		container.classList.toggle('disabled', !this.isEnabled());
		container.appendChild(this.element);
	}

	setActionContext(context: unknown): void {
		this.context = context;
	}

	isEnabled(): boolean {
		return this.action.enabled !== false;
	}

	focus(): void {
		this.element.tabIndex = 0;
		this.element.focus();
		this.element.classList.add('focused');
	}

	blur(): void {
		this.element.tabIndex = -1;
		this.element.blur();
		this.element.classList.remove('focused');
	}

	private async run(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		try {
			await this.actionRunner.run(this.action, this.context);
		} catch (error) {
			reportFailure(`actionbar.run.${this.action.id}`, error);
		}
	}

	private getActionLabelClass(): string {
		const classes = ['action-label'];
		if (this.action.class) {
			classes.push(this.action.class);
		}
		return classes.join(' ');
	}

	private renderLabel(): void {
		this.element.textContent = '';
		if (this.action.icon) {
			const icon = document.createElement('span');
			icon.className = `action-icon codicon ${this.action.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			this.element.appendChild(icon);
		}

		const label = document.createElement('span');
		label.className = 'action-label-text';
		label.textContent = this.action.label;
		this.element.appendChild(label);

		if (this.action.keybinding) {
			const keybinding = document.createElement('span');
			keybinding.className = 'keybinding sessions-sidebar-keybinding';
			keybinding.textContent = this.action.keybinding;
			this.element.appendChild(keybinding);
		}
	}

	private updateEnabled(): void {
		this.element.setAttribute('aria-disabled', String(!this.isEnabled()));
	}

	private updateTooltip(): void {
		const tooltip = this.action.tooltip ?? this.action.label;
		this.element.title = tooltip;
		this.element.setAttribute('aria-label', tooltip);
	}
}
