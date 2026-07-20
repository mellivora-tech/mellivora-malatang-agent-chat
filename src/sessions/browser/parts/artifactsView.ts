/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../common/i18n/i18n.js';
import { formatTimestamp } from '../../common/relativeTime.js';
import { clearNode } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { IArtifactEntryData, IArtifactsBridge } from '../../services/artifacts/common/artifacts.js';
import { artifactKindIcon, groupArtifactsBySession } from '../../services/artifacts/common/artifactsPresentation.js';
import type { ISessionsPartService } from '../../services/sessions/browser/sessionsPartService.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';

export interface IArtifactsViewOptions {
	readonly sessionsService?: ISessionsService;
	readonly sessionsPartService?: ISessionsPartService;
	readonly artifacts?: IArtifactsBridge;
}

/**
 * The artifacts tab (#13 P1): session-grouped index rows with "find it, open
 * it" jumps. Mounting rebuilds the visible scopes from the transcripts — that
 * lazy backfill is what makes pre-P0 sessions show up without any migration.
 */
export class ArtifactsView extends Disposable {
	private readonly root: HTMLElement;
	// Once per view lifetime per scope — rebuild rescans every transcript, so
	// repeating it on each session switch would be pure waste.
	private readonly rebuiltScopes = new Set<string>();
	private currentProjectId: string | undefined;
	private entries: readonly IArtifactEntryData[] = [];
	private loadToken = 0;
	private disposed = false;

	constructor(
		container: HTMLElement,
		private readonly options: IArtifactsViewOptions,
	) {
		super();
		this._register(toDisposable(() => {
			this.disposed = true;
		}));
		this.root = container.appendChild(document.createElement('div'));
		this.root.className = 'artifacts-view';

		// The ACTIVE session names the project whose scope gets (re)built; the
		// listing itself is cross-scope so nothing the index knows is hidden.
		const active = this.options.sessionsService?.activeSession;
		if (active) {
			this._register(active.subscribe(() => this.onActiveSessionChanged()));
		}
		this.currentProjectId = active?.get()?.projectId;
		void this.load();
	}

	private onActiveSessionChanged(): void {
		const projectId = this.options.sessionsService?.activeSession.get()?.projectId;
		this.currentProjectId = projectId;
		// Reload even for an unchanged scope: a finished run may have produced
		// new artifacts, and the index has no push channel (P1 scope).
		void this.load();
	}

	private async load(): Promise<void> {
		const bridge = this.options.artifacts;
		if (!bridge) {
			this.render();
			return;
		}
		const token = ++this.loadToken;
		// The current project's scope plus the projectless one — the acceptance
		// backfill: opening the tab regenerates the index for existing sessions.
		const scopes: (string | undefined)[] = this.currentProjectId !== undefined ? [this.currentProjectId, undefined] : [undefined];
		for (const scope of scopes) {
			const key = scope ?? '';
			if (!this.rebuiltScopes.has(key)) {
				this.rebuiltScopes.add(key);
				try {
					await bridge.rebuild(scope);
				} catch {
					// A failed rebuild leaves the previous index — still listable.
				}
			}
		}
		let entries: readonly IArtifactEntryData[] = [];
		try {
			entries = await bridge.list();
		} catch {
			// Listing failure degrades to the empty state.
		}
		if (this.disposed || token !== this.loadToken) {
			return;
		}
		this.entries = entries;
		this.render();
	}

	private render(): void {
		clearNode(this.root);
		if (this.entries.length === 0) {
			const empty = this.root.appendChild(document.createElement('div'));
			empty.className = 'artifacts-empty';
			empty.textContent = localize('artifacts.empty');
			return;
		}
		const sessions = this.options.sessionsService?.getSessions() ?? [];
		for (const group of groupArtifactsBySession(this.entries)) {
			const section = this.root.appendChild(document.createElement('div'));
			section.className = 'artifacts-group';
			section.dataset['sessionId'] = group.sessionId;

			const header = section.appendChild(document.createElement('div'));
			header.className = 'artifacts-group-header';
			// A deleted session's index rows are cleaned up with the session, but a
			// cross-scope listing may still race one — the id prefix keeps it usable.
			header.textContent = sessions.find(session => session.sessionId === group.sessionId)?.title.get() ?? group.sessionId.slice(0, 8);

			for (const entry of group.entries) {
				section.appendChild(this.renderRow(entry));
			}
		}
	}

	private renderRow(entry: IArtifactEntryData): HTMLElement {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = 'artifact-row';
		row.dataset['artifactId'] = entry.id;
		row.dataset['artifactKind'] = entry.kind;
		if (entry.superseded) {
			row.classList.add('artifact-row-superseded');
			row.title = localize('artifacts.superseded');
		} else {
			row.title = entry.title;
		}
		row.addEventListener('click', () => this.open(entry, row));

		const icon = row.appendChild(document.createElement('span'));
		icon.className = `codicon ${artifactKindIcon(entry.kind)}`;
		icon.setAttribute('aria-hidden', 'true');

		const title = row.appendChild(document.createElement('span'));
		title.className = 'artifact-row-title';
		title.textContent = entry.title;

		const time = row.appendChild(document.createElement('span'));
		time.className = 'artifact-row-time';
		time.textContent = formatTimestamp(new Date(entry.createdAt));

		return row;
	}

	/** Issue P1 contract: 找得到、打得开 — each payload shape has one opening path. */
	private open(entry: IArtifactEntryData, row: HTMLElement): void {
		const payload = entry.payload;
		if (payload.type === 'message') {
			// Open first, then hand the scroll target to whichever conversation
			// view hosts the session (consume-once observable, dataBrowse-style).
			this.options.sessionsService?.openSession(entry.sessionId);
			this.options.sessionsPartService?.revealArtifactMessage(entry.sessionId, payload.messageId);
		} else if (payload.type === 'media') {
			if (entry.kind === 'document') {
				// A document's home is its conversation (the reference card holds the
				// expand) — the data browser can only parse tabular files.
				this.options.sessionsService?.openSession(entry.sessionId);
			} else {
				this.options.sessionsPartService?.openDataBrowser({ kind: 'file', path: payload.path, name: entry.title });
			}
		} else {
			void this.options.artifacts?.reveal(payload.path).then(found => {
				// Export paths live outside the data root; a vanished file is marked
				// stale in place rather than silently doing nothing.
				if (!found && !this.disposed) {
					row.classList.add('artifact-row-missing');
					row.title = localize('artifacts.missing');
				}
			});
		}
	}
}
