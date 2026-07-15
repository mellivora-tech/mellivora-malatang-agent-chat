/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IActiveSession, ISessionDataBrowse } from '../common/session.js';

export const ISessionsPartService = createDecorator<ISessionsPartService>('sessionsPartService');

export type WorkbenchMode = 'newSession' | 'conversation';

export interface ISessionsPartService {
	readonly mode: ReturnType<typeof observableValue<WorkbenchMode>>;
	readonly sidePaneVisible: ReturnType<typeof observableValue<boolean>>;
	readonly auxiliaryBarVisible: ReturnType<typeof observableValue<boolean>>;
	readonly visibleSessions: ReturnType<typeof observableValue<readonly (IActiveSession | undefined)[]>>;
	readonly activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>;
	/** Side pane fills the whole content row (the chat column hides). */
	readonly sidePaneMaximized: ReturnType<typeof observableValue<boolean>>;
	toggleSidePaneMaximized(): void;
	/** Chat → data browser: a query to keep exploring; the side pane consumes it (resets to undefined). */
	readonly dataBrowseRequest: ReturnType<typeof observableValue<ISessionDataBrowse | undefined>>;
	/** Data browser → composer: reference text to append; the conversation view consumes it. */
	readonly composerInsertRequest: ReturnType<typeof observableValue<string | undefined>>;
	showNewSession(): void;
	showConversation(showAuxiliaryBar?: boolean): void;
	toggleSidePane(): void;
	hideSidePane(): void;
	showSidePane(): void;
	/** Open the side pane on the data tab and run this query there. */
	openDataBrowser(request: ISessionDataBrowse): void;
	/** Append structured reference text to the conversation composer. */
	insertIntoComposer(text: string): void;
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void;
}

export class SessionsPartService implements ISessionsPartService {
	readonly mode = observableValue<WorkbenchMode>('newSession');
	readonly sidePaneVisible = observableValue<boolean>(false);
	readonly auxiliaryBarVisible = this.sidePaneVisible;
	readonly visibleSessions = observableValue<readonly (IActiveSession | undefined)[]>([undefined]);
	readonly activeSession = observableValue<IActiveSession | undefined>(undefined);

	showNewSession(): void {
		this.mode.set('newSession');
		this.hideSidePane();
	}

	showConversation(showAuxiliaryBar?: boolean): void {
		this.mode.set('conversation');
		if (showAuxiliaryBar === true) {
			this.showSidePane();
		} else if (showAuxiliaryBar === false) {
			this.hideSidePane();
		}
	}

	toggleSidePane(): void {
		this.sidePaneVisible.set(!this.sidePaneVisible.get());
	}

	hideSidePane(): void {
		this.sidePaneVisible.set(false);
		// Closing the pane always restores the chat column — reopening later must
		// not surprise-maximize.
		this.sidePaneMaximized.set(false);
	}

	readonly sidePaneMaximized = observableValue<boolean>(false);

	toggleSidePaneMaximized(): void {
		this.sidePaneMaximized.set(!this.sidePaneMaximized.get());
	}

	showSidePane(): void {
		this.sidePaneVisible.set(true);
	}

	readonly dataBrowseRequest = observableValue<ISessionDataBrowse | undefined>(undefined);
	readonly composerInsertRequest = observableValue<string | undefined>(undefined);

	openDataBrowser(request: ISessionDataBrowse): void {
		this.showSidePane();
		this.dataBrowseRequest.set(request);
	}

	insertIntoComposer(text: string): void {
		this.composerInsertRequest.set(text);
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions.set(visible);
		this.activeSession.set(active);
	}
}
