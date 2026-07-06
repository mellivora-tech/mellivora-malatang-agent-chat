/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { IActiveSession, ISessionChangesSummary } from '../../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface IChangesViewOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

export class ChangesView extends Disposable {
	private readonly activeSessionStore = this._register(new DisposableStore());

	constructor(
		private readonly container: HTMLElement,
		private readonly options: IChangesViewOptions = {},
	) {
		super();
		this.bind();
		this.render();
	}

	private bind(): void {
		const activeSession = this.options.sessionsService?.activeSession ?? this.options.sessionsPartService?.activeSession;
		if (activeSession) {
			this._register(activeSession.subscribe(() => this.render()));
		}
	}

	private render(): void {
		this.activeSessionStore.clear();
		this.container.textContent = '';

		const session = this.options.sessionsService?.activeSession.get() ?? this.options.sessionsPartService?.activeSession.get();
		if (session) {
			for (const observable of [session.title, session.workspace, session.changesSummary]) {
				this.activeSessionStore.add(observable.subscribe(() => this.render()));
			}
		}

		const root = document.createElement('div');
		root.className = 'changes-view';
		this.container.appendChild(root);

		const header = document.createElement('div');
		header.className = 'changes-view-header';
		const title = document.createElement('div');
		title.className = 'changes-view-title';
		title.textContent = 'Changes';
		header.appendChild(title);
		const subtitle = document.createElement('div');
		subtitle.className = 'changes-view-subtitle';
		subtitle.textContent = session?.title.get() ?? 'No active session';
		header.appendChild(subtitle);
		root.appendChild(header);

		const summary = session?.changesSummary.get();
		if (summary && session) {
			this.renderSummary(root, summary);
			this.renderChangedFiles(root, summary, session);
		} else {
			this.renderEmpty(root, session);
		}
	}

	private renderSummary(container: HTMLElement, summary: ISessionChangesSummary): void {
		const summaryElement = document.createElement('div');
		summaryElement.className = 'changes-summary';

		for (const item of [
			{ label: 'Files', value: `${summary.files}`, className: 'files' },
			{ label: 'Additions', value: `+${summary.additions}`, className: 'additions' },
			{ label: 'Deletions', value: `-${summary.deletions}`, className: 'deletions' },
		]) {
			const stat = document.createElement('div');
			stat.className = `changes-summary-stat ${item.className}`;
			const value = document.createElement('span');
			value.className = 'changes-summary-value';
			value.textContent = item.value;
			stat.appendChild(value);
			const label = document.createElement('span');
			label.className = 'changes-summary-label';
			label.textContent = item.label;
			stat.appendChild(label);
			summaryElement.appendChild(stat);
		}

		container.appendChild(summaryElement);
	}

	private renderChangedFiles(container: HTMLElement, summary: ISessionChangesSummary, session: IActiveSession): void {
		const list = document.createElement('div');
		list.className = 'changes-file-list';

		const workspace = session.workspace.get()?.label ?? 'workspace';
		const files = [
			`src/sessions/browser/parts/titlebarPart.ts`,
			`src/sessions/browser/parts/sidebarPart.ts`,
			`src/sessions/browser/parts/auxiliaryBarPart.ts`,
			`${workspace}/package.json`,
		].slice(0, Math.max(1, Math.min(summary.files, 4)));

		for (const [index, file] of files.entries()) {
			const row = document.createElement('div');
			row.className = 'changes-file-row';

			const icon = document.createElement('span');
			icon.className = `codicon ${index === files.length - 1 ? 'codicon-json' : 'codicon-file-code'}`;
			icon.setAttribute('aria-hidden', 'true');
			row.appendChild(icon);

			const name = document.createElement('span');
			name.className = 'changes-file-name';
			name.textContent = file;
			row.appendChild(name);

			const stats = document.createElement('span');
			stats.className = 'changes-file-stats';
			stats.textContent = `+${Math.max(1, Math.round(summary.additions / files.length))} -${Math.max(1, Math.round(summary.deletions / files.length))}`;
			row.appendChild(stats);

			list.appendChild(row);
		}

		container.appendChild(list);
	}

	private renderEmpty(container: HTMLElement, session: IActiveSession | undefined): void {
		const empty = document.createElement('div');
		empty.className = 'changes-empty';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-git-compare';
		icon.setAttribute('aria-hidden', 'true');
		empty.appendChild(icon);

		const message = document.createElement('span');
		message.textContent = session ? 'No changed files for this session' : 'Open a session to inspect changes';
		empty.appendChild(message);

		container.appendChild(empty);
	}
}
