/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface ITitlebarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	readonly onToggleSidebar?: () => void;
}

export class TitlebarPart extends Part {
	readonly minimumWidth = 0;
	readonly minimumHeight = 52;
	readonly priority = LayoutPriority.Low;

	private sidePaneToggleButton: HTMLButtonElement | undefined;

	constructor(private readonly options: ITitlebarPartOptions = {}) {
		super('workbench.parts.titlebar', 'titlebar');
		if (this.options.sessionsPartService) {
			this._register(this.options.sessionsPartService.sidePaneVisible.subscribe(() => this.updateSidePaneToggleState()));
		}
	}

	protected render(container: HTMLElement): void {
		container.textContent = '';

		const titlebar = document.createElement('div');
		titlebar.className = 'titlebar-container sessions-titlebar-container';

		const dragRegion = document.createElement('div');
		dragRegion.className = 'titlebar-drag-region';
		titlebar.appendChild(dragRegion);

		const left = document.createElement('div');
		left.className = 'titlebar-left';
		this.renderLeft(left);
		titlebar.appendChild(left);

		const right = document.createElement('div');
		right.className = 'titlebar-right';
		this.renderRight(right);
		titlebar.appendChild(right);

		container.appendChild(titlebar);
	}

	private renderLeft(container: HTMLElement): void {
		container.appendChild(
			this.createTitlebarButton({
				label: 'Toggle Sidebar',
				icon: 'codicon-layout-sidebar-left',
				className: 'sessions-sidebar-toggle',
				onClick: () => this.options.onToggleSidebar?.(),
			}),
		);
		container.appendChild(this.createTitlebarButton({ label: 'Back', icon: 'codicon-arrow-left' }));
		container.appendChild(this.createTitlebarButton({ label: 'Forward', icon: 'codicon-arrow-right' }));
		container.appendChild(
			this.createTitlebarButton({
				label: 'New Task',
				icon: 'codicon-new-session',
				className: 'sessions-titlebar-new-task',
				onClick: () => this.options.sessionsPartService?.showNewSession(),
			}),
		);
	}

	private renderRight(container: HTMLElement): void {
		this.sidePaneToggleButton = this.createTitlebarButton({
			label: 'Toggle Side Pane',
			icon: 'codicon-layout-sidebar-right',
			className: 'sessions-titlebar-side-pane-toggle',
			onClick: () => this.options.sessionsPartService?.toggleSidePane(),
		});
		container.appendChild(this.sidePaneToggleButton);
		this.updateSidePaneToggleState();

		container.appendChild(
			this.createTitlebarButton({
				label: 'Help',
				icon: 'codicon-question',
				className: 'sessions-titlebar-help',
			}),
		);
	}

	private updateSidePaneToggleState(): void {
		const visible = Boolean(this.options.sessionsPartService?.sidePaneVisible.get());
		this.sidePaneToggleButton?.classList.toggle('active', visible);
		this.sidePaneToggleButton?.setAttribute('aria-pressed', String(visible));
	}

	private createTitlebarButton(options: { readonly label: string; readonly icon: string; readonly className?: string; readonly onClick?: () => void }): HTMLButtonElement {
		const button = document.createElement('button');
		button.className = `sessions-titlebar-nav-action${options.className ? ` ${options.className}` : ''}`;
		button.type = 'button';
		button.title = options.label;
		button.setAttribute('aria-label', options.label);
		if (options.onClick) {
			button.addEventListener('click', options.onClick);
		}

		const icon = document.createElement('span');
		icon.className = `codicon ${options.icon}`;
		icon.setAttribute('aria-hidden', 'true');
		button.appendChild(icon);
		return button;
	}
}
