/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IActiveSession } from '../common/session.js';

export const ISessionsPartService = createDecorator<ISessionsPartService>('sessionsPartService');

export type WorkbenchMode = 'newSession' | 'sessionDetail';

export interface ISessionsPartService {
	readonly mode: ReturnType<typeof observableValue<WorkbenchMode>>;
	readonly sidePaneVisible: ReturnType<typeof observableValue<boolean>>;
	readonly auxiliaryBarVisible: ReturnType<typeof observableValue<boolean>>;
	readonly visibleSessions: ReturnType<typeof observableValue<readonly (IActiveSession | undefined)[]>>;
	readonly activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>;
	showNewSession(): void;
	showSessionDetail(showAuxiliaryBar?: boolean): void;
	toggleSidePane(): void;
	hideSidePane(): void;
	showSidePane(): void;
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

	showSessionDetail(showAuxiliaryBar?: boolean): void {
		this.mode.set('sessionDetail');
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
	}

	showSidePane(): void {
		this.sidePaneVisible.set(true);
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions.set(visible);
		this.activeSession.set(active);
	}
}
