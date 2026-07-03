/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import type { IActiveSession, ISessionChangesSummary } from '../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Part } from '../part.js';

export interface ITitlebarPartOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

export class TitlebarPart extends Part {
	readonly minimumWidth = 0;
	readonly minimumHeight = 35;
	readonly priority = LayoutPriority.Low;

	private readonly activeSessionStore = this._register(new DisposableStore());
	private center!: HTMLElement;

	constructor(private readonly options: ITitlebarPartOptions = {}) {
		super('workbench.parts.titlebar', 'titlebar');
	}

	protected render(container: HTMLElement): void {
		container.textContent = '';

		const titlebar = document.createElement('div');
		titlebar.className = 'titlebar-container sessions-titlebar-container has-center';

		const dragRegion = document.createElement('div');
		dragRegion.className = 'titlebar-drag-region';
		titlebar.appendChild(dragRegion);

		const left = document.createElement('div');
		left.className = 'titlebar-left';
		this.renderLeft(left);
		titlebar.appendChild(left);

		this.center = document.createElement('div');
		this.center.className = 'titlebar-center';
		titlebar.appendChild(this.center);

		const right = document.createElement('div');
		right.className = 'titlebar-right';
		this.renderRight(right);
		titlebar.appendChild(right);

		container.appendChild(titlebar);
		this.bindActiveSession();
	}

	private renderLeft(container: HTMLElement): void {
		const brand = document.createElement('div');
		brand.className = 'sessions-titlebar-brand';
		const icon = document.createElement('span');
		icon.className = 'codicon codicon-layout-sidebar-left';
		icon.setAttribute('aria-hidden', 'true');
		brand.appendChild(icon);
		const label = document.createElement('span');
		label.textContent = 'Agent Chat';
		brand.appendChild(label);
		container.appendChild(brand);
	}

	private renderRight(container: HTMLElement): void {
		for (const action of [
			{ icon: 'codicon-remote', label: 'Remote' },
			{ icon: 'codicon-terminal', label: 'Terminal' },
			{ icon: 'codicon-layout-sidebar-right', label: 'Toggle Auxiliary Bar' },
			{ icon: 'codicon-account', label: 'Account' }
		]) {
			const button = document.createElement('button');
			button.className = 'sessions-titlebar-action';
			button.type = 'button';
			button.title = action.label;
			button.setAttribute('aria-label', action.label);

			const icon = document.createElement('span');
			icon.className = `codicon ${action.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			button.appendChild(icon);
			container.appendChild(button);
		}
	}

	private bindActiveSession(): void {
		const activeSession = this.options.sessionsPartService?.activeSession ?? this.options.sessionsService?.activeSession;
		const mode = this.options.sessionsPartService?.mode;
		if (mode) {
			this._register(mode.subscribe(() => this.renderCommandCenter(activeSession?.get())));
		}

		if (!activeSession) {
			this.renderCommandCenter(undefined);
			return;
		}

		this._register(activeSession.subscribe(session => this.renderCommandCenter(session)));
		this.renderCommandCenter(activeSession.get());
	}

	private renderCommandCenter(session: IActiveSession | undefined): void {
		this.activeSessionStore.clear();
		this.center.textContent = '';
		const isNewSession = this.options.sessionsPartService?.mode.get() === 'newSession';

		if (session && !isNewSession) {
			for (const observable of [session.title, session.workspace, session.changesSummary]) {
				this.activeSessionStore.add(observable.subscribe(() => this.renderCommandCenter(session)));
			}
		}

		const commandBox = document.createElement('button');
		commandBox.className = 'sessions-command-center';
		commandBox.type = 'button';
		commandBox.title = 'Active session';

		const providerIcon = document.createElement('span');
		providerIcon.className = `codicon ${isNewSession ? 'codicon-add' : session?.icon ?? 'codicon-copilot'}`;
		providerIcon.setAttribute('aria-hidden', 'true');
		commandBox.appendChild(providerIcon);

		const title = document.createElement('span');
		title.className = 'sessions-command-title';
		title.textContent = isNewSession ? 'New Session' : session?.title.get() ?? 'Agent session';
		commandBox.appendChild(title);

		if (isNewSession) {
			this.center.appendChild(commandBox);
			return;
		}

		const workspace = session?.workspace.get();
		if (workspace) {
			commandBox.appendChild(this.createSeparator());
			commandBox.appendChild(this.createMeta(workspace.label, 'codicon-root-folder'));
		}

		if (workspace?.branchName) {
			commandBox.appendChild(this.createSeparator());
			commandBox.appendChild(this.createMeta(workspace.branchName, 'codicon-git-branch'));
		}

		const summary = session?.changesSummary.get();
		if (summary) {
			commandBox.appendChild(this.createSeparator());
			commandBox.appendChild(this.createDiff(summary));
		}

		this.center.appendChild(commandBox);
	}

	private createSeparator(): HTMLElement {
		const separator = document.createElement('span');
		separator.className = 'sessions-command-separator';
		separator.textContent = '/';
		return separator;
	}

	private createMeta(label: string, iconClass: string): HTMLElement {
		const meta = document.createElement('span');
		meta.className = 'sessions-command-meta';

		const icon = document.createElement('span');
		icon.className = `codicon ${iconClass}`;
		icon.setAttribute('aria-hidden', 'true');
		meta.appendChild(icon);

		const text = document.createElement('span');
		text.textContent = label;
		meta.appendChild(text);

		return meta;
	}

	private createDiff(summary: ISessionChangesSummary): HTMLElement {
		const diff = document.createElement('span');
		diff.className = 'sessions-command-diff';
		diff.title = `${summary.files} changed files`;

		const additions = document.createElement('span');
		additions.className = 'sessions-diff-additions';
		additions.textContent = `+${summary.additions}`;
		diff.appendChild(additions);

		const deletions = document.createElement('span');
		deletions.className = 'sessions-diff-deletions';
		deletions.textContent = `-${summary.deletions}`;
		diff.appendChild(deletions);

		return diff;
	}
}
