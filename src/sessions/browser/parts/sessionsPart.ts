/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { clearNode } from '../../base/browser/dom.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import { Part } from '../part.js';
import { SessionView } from './sessionView.js';
import type { IChatRequestSender } from './chatView.js';

export class SessionsPart extends Part {
	readonly minimumWidth = 640;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.High;

	private readonly slots: SessionView[] = [];
	private container: HTMLElement | undefined;
	private visibleSessions: readonly (IActiveSession | undefined)[] = [undefined];
	private activeSession: IActiveSession | undefined;
	private width = 0;
	private height = 0;

	constructor(private readonly requestSender?: IChatRequestSender) {
		super('workbench.parts.sessions', 'sessionspart');
	}

	updateVisibleSessions(visible: readonly (IActiveSession | undefined)[], active: IActiveSession | undefined): void {
		this.visibleSessions = visible;
		this.activeSession = active;
		this.syncSlots();
	}

	focusSession(sessionId: string | undefined): void {
		const targetSessionId = sessionId ?? this.activeSession?.sessionId;
		const targetIndex = targetSessionId
			? this.visibleSessions.findIndex(session => session?.sessionId === targetSessionId)
			: -1;
		const slot = this.slots[targetIndex] ?? this.slots[0];
		slot?.focus();
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		this.width = this.element.clientWidth;
		this.height = this.element.clientHeight;
		this.layoutSlots();
	}

	protected override render(container: HTMLElement): void {
		clearNode(container);
		this.container = document.createElement('div');
		this.container.className = 'sessions-part-container';
		container.appendChild(this.container);
		this.syncSlots();
	}

	private syncSlots(): void {
		if (!this.container) {
			return;
		}

		const desiredCount = Math.max(this.visibleSessions.length, 1);

		while (this.slots.length < desiredCount) {
			const slot = this._register(new SessionView(this.requestSender));
			this.slots.push(slot);
			this.container.appendChild(slot.element);
		}

		while (this.slots.length > desiredCount) {
			const slot = this.slots.pop();
			slot?.element.remove();
			slot?.dispose();
		}

		for (let index = 0; index < this.slots.length; index++) {
			const slot = this.slots[index]!;
			const session = this.visibleSessions[index];
			slot.openSession(session);
			slot.setActive(this.slots.length === 1 || Boolean(session && session.sessionId === this.activeSession?.sessionId));
		}

		this.layoutSlots();
	}

	private layoutSlots(): void {
		if (this.slots.length === 0) {
			return;
		}

		const slotWidth = this.width > 0 ? this.width / this.slots.length : 0;
		for (const slot of this.slots) {
			slot.layout(slotWidth, this.height);
		}
	}
}
