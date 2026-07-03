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
	readonly visibleSessions: ReturnType<typeof observableValue<readonly (IActiveSession | undefined)[]>>;
	readonly activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>;
	showNewSession(): void;
	showSessionDetail(): void;
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void;
}

export class SessionsPartService implements ISessionsPartService {
	readonly mode = observableValue<WorkbenchMode>('newSession');
	readonly visibleSessions = observableValue<readonly (IActiveSession | undefined)[]>([undefined]);
	readonly activeSession = observableValue<IActiveSession | undefined>(undefined);

	showNewSession(): void {
		this.mode.set('newSession');
	}

	showSessionDetail(): void {
		this.mode.set('sessionDetail');
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions.set(visible);
		this.activeSession.set(active);
	}
}
