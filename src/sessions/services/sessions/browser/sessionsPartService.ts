/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { IActiveSession } from '../common/session.js';

export const ISessionsPartService = createDecorator<ISessionsPartService>('sessionsPartService');

export interface ISessionsPartService {
	readonly visibleSessions: ReturnType<typeof observableValue<readonly (IActiveSession | undefined)[]>>;
	readonly activeSession: ReturnType<typeof observableValue<IActiveSession | undefined>>;
	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void;
}

export class SessionsPartService implements ISessionsPartService {
	readonly visibleSessions = observableValue<readonly (IActiveSession | undefined)[]>([undefined]);
	readonly activeSession = observableValue<IActiveSession | undefined>(undefined);

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions.set(visible);
		this.activeSession.set(active);
	}
}
