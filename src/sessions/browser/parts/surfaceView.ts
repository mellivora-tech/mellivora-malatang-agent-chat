/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { parseSurfacePatchProps } from '../../services/sessions/common/uiComponents/surfacePatch.js';
import { SurfacePanel } from './agentUi/components/SurfacePanel.js';

export interface ISurfaceViewOptions {
	readonly sessionsService?: ISessionsService;
}

/**
 * The workbench-surface tab host (#12 M4): tracks the ACTIVE session, collects
 * its surface_patch batches from the message stream (the persisted truth) and
 * hands them to the React fold/renderer. Reopening a session re-collects and
 * re-folds — the surface has NO persistence of its own (design §5).
 */
export class SurfaceView extends Disposable {
	private readonly reactRoot: Root;
	private readonly sessionSubscriptions = this._register(new DisposableStore());
	private session: IActiveSession | undefined;

	constructor(
		container: HTMLElement,
		private readonly options: ISurfaceViewOptions,
	) {
		super();
		const host = container.appendChild(document.createElement('div'));
		host.className = 'surface-view';
		this.reactRoot = createRoot(host);
		this._register(toDisposable(() => this.reactRoot.unmount()));

		const active = this.options.sessionsService?.activeSession;
		if (active) {
			this._register(active.subscribe(() => this.bindSession(active.get())));
			this.bindSession(active.get());
		} else {
			this.renderBatches([]);
		}
	}

	private bindSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			return;
		}
		this.session = session;
		this.sessionSubscriptions.clear();
		if (session) {
			this.sessionSubscriptions.add(session.messages.subscribe(() => this.collect()));
		}
		this.collect();
	}

	private collect(): void {
		const messages = this.session?.messages.get() ?? [];
		const patches: { surface: string; statements: string }[] = [];
		for (const message of messages) {
			if (message.role !== 'ui' || message.ui?.component !== 'surface_patch') {
				continue;
			}
			// Re-run the validator — an on-disk payload may predate schema changes
			// (same posture as the card registry).
			const parsed = parseSurfacePatchProps(message.ui.props);
			if (parsed) {
				patches.push(parsed);
			}
		}
		// M4: one active surface per session — the LAST patch names it.
		const surface = patches[patches.length - 1]?.surface;
		this.renderBatches(patches.filter(patch => patch.surface === surface).map(patch => patch.statements));
	}

	private renderBatches(batches: readonly string[]): void {
		const sessionId = this.session?.sessionId;
		const sessionsService = this.options.sessionsService;
		this.reactRoot.render(
			createElement(SurfacePanel, {
				batches,
				onToAssistant: (text: string) => {
					if (sessionId && sessionsService) {
						void sessionsService.sendMessage(sessionId, text);
					}
				},
			}),
		);
	}
}

export const SURFACE_TAB_LABEL = (): string => localize('aux.tab.surface');
