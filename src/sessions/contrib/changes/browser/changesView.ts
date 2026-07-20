/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../common/i18n/i18n.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import type { ISessionChangesSummary } from '../../../services/sessions/common/session.js';
import type { ISessionsPartService } from '../../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';

export interface IChangesViewOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
}

/** One rendered file row of the Review tab (#13 P2) — real diff data, presentation-ready. */
export interface IChangesFileRow {
	readonly path: string;
	readonly icon: string;
	readonly addedLabel: string;
	readonly removedLabel: string;
}

export type ChangesFilesPresentation =
	| { readonly kind: 'rows'; readonly rows: readonly IChangesFileRow[] }
	/** Counts exist but no per-file detail — a summary persisted before #13 P2; the next run end fills it in. */
	| { readonly kind: 'stale' }
	| { readonly kind: 'empty' };

/**
 * Pure presenter for the file list (#13 P2), extracted so the bare-node unit
 * tests can cover the real-data rendering without a DOM.
 */
export function presentChangedFiles(summary: ISessionChangesSummary): ChangesFilesPresentation {
	const files = summary.changedFiles;
	if (files === undefined) {
		return summary.files > 0 ? { kind: 'stale' } : { kind: 'empty' };
	}
	if (files.length === 0) {
		return { kind: 'empty' };
	}
	return {
		kind: 'rows',
		rows: files.map(file => ({
			path: file.path,
			icon: file.path.endsWith('.json') ? 'codicon-json' : 'codicon-file-code',
			addedLabel: `+${file.added}`,
			removedLabel: `-${file.removed}`,
		})),
	};
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
		title.textContent = localize('changes.title');
		header.appendChild(title);
		const subtitle = document.createElement('div');
		subtitle.className = 'changes-view-subtitle';
		subtitle.textContent = session?.title.get() ?? localize('changes.noSession');
		header.appendChild(subtitle);
		root.appendChild(header);

		const summary = session?.changesSummary.get();
		if (summary && session) {
			this.renderSummary(root, summary);
			this.renderChangedFiles(root, summary);
		} else {
			this.renderEmpty(root, session !== undefined ? localize('changes.empty.noChanges') : localize('changes.empty.openSession'));
		}
	}

	private renderSummary(container: HTMLElement, summary: ISessionChangesSummary): void {
		const summaryElement = document.createElement('div');
		summaryElement.className = 'changes-summary';

		for (const item of [
			{ label: localize('changes.stat.files'), value: `${summary.files}`, className: 'files' },
			{ label: localize('changes.stat.additions'), value: `+${summary.additions}`, className: 'additions' },
			{ label: localize('changes.stat.deletions'), value: `-${summary.deletions}`, className: 'deletions' },
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

	/** The real file list (#13 P2) — one row per changed path from git's numstat, no placeholders. */
	private renderChangedFiles(container: HTMLElement, summary: ISessionChangesSummary): void {
		const presentation = presentChangedFiles(summary);
		if (presentation.kind === 'stale') {
			// Counts persisted before #13 P2 carried no file detail — say so
			// instead of inventing rows; the next run end refreshes the summary.
			this.renderEmpty(container, localize('changes.list.stale'));
			return;
		}
		if (presentation.kind === 'empty') {
			this.renderEmpty(container, localize('changes.empty.noChanges'));
			return;
		}

		const list = document.createElement('div');
		list.className = 'changes-file-list';

		for (const row of presentation.rows) {
			const rowElement = document.createElement('div');
			rowElement.className = 'changes-file-row';
			rowElement.title = row.path;

			const icon = document.createElement('span');
			icon.className = `codicon ${row.icon}`;
			icon.setAttribute('aria-hidden', 'true');
			rowElement.appendChild(icon);

			const name = document.createElement('span');
			name.className = 'changes-file-name';
			name.textContent = row.path;
			rowElement.appendChild(name);

			const stats = document.createElement('span');
			stats.className = 'changes-file-stats';
			const added = document.createElement('span');
			added.className = 'changes-file-added';
			added.textContent = row.addedLabel;
			stats.appendChild(added);
			const removed = document.createElement('span');
			removed.className = 'changes-file-removed';
			removed.textContent = row.removedLabel;
			stats.appendChild(removed);
			rowElement.appendChild(stats);

			list.appendChild(rowElement);
		}

		container.appendChild(list);
	}

	private renderEmpty(container: HTMLElement, message: string): void {
		const empty = document.createElement('div');
		empty.className = 'changes-empty';

		const icon = document.createElement('span');
		icon.className = 'codicon codicon-git-compare';
		icon.setAttribute('aria-hidden', 'true');
		empty.appendChild(icon);

		const messageElement = document.createElement('span');
		messageElement.textContent = message;
		empty.appendChild(messageElement);

		container.appendChild(empty);
	}
}
