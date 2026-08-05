/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { ISessionMessage } from '../../services/sessions/common/session.js';

interface ITurn {
	user?: ISessionMessage;
	work?: ISessionMessage;
	assistant?: ISessionMessage;
	blocks: ISessionMessage[];
}

/**
 * The left-hand turn rail: one tick per turn, dock-style magnification on
 * hover, a scrub preview card, and a current-turn highlight driven by the
 * transcript scroll position. Extracted from ConversationView to keep the
 * main view focused on session lifecycle and the composer.
 */
export class TimelineRail extends Disposable {
	readonly element: HTMLElement;
	private readonly tickTurns = new Map<HTMLElement, ITurn>();
	private previewTick: HTMLElement | undefined;
	private timelinePreview: HTMLElement | undefined;

	constructor(
		private readonly host: HTMLElement,
		private readonly transcript: HTMLElement,
	) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'conversation-timeline';
		this.element.setAttribute('role', 'navigation');
		this.element.setAttribute('aria-label', localize('conv.timeline'));
	}

	override dispose(): void {
		this.closeTimelinePreview();
		super.dispose();
	}

	render(messages: readonly ISessionMessage[]): void {
		clearNode(this.element);
		this.closeTimelinePreview();
		this.previewTick = undefined;
		this.tickTurns.clear();

		const turns: ITurn[] = [];
		for (const message of messages) {
			if (message.role === 'tool') {
				continue;
			}
			if (message.role === 'user' || turns.length === 0) {
				turns.push({ blocks: [] });
			}
			const turn = turns[turns.length - 1]!;
			turn.blocks.push(message);
			if (message.role === 'user') {
				turn.user = message;
			} else if (message.role === 'work') {
				turn.work = message;
			} else if (message.role === 'assistant') {
				turn.assistant = message;
			}
		}

		this.element.classList.toggle('empty', turns.length < 2);

		for (const turn of turns) {
			const firstBlock = turn.blocks[0]!;
			const tick = append(this.element, document.createElement('button')) as HTMLButtonElement;
			tick.className = 'conversation-timeline-tick';
			tick.type = 'button';
			tick.dataset.targetId = firstBlock.id;
			tick.dataset.blockIds = turn.blocks.map(block => block.id).join(' ');
			tick.setAttribute('aria-label', localize('conv.jumpToTurn'));
			tick.addEventListener('click', () => {
				this.transcript.querySelector(`[data-message-id="${firstBlock.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
			});
			this.tickTurns.set(tick, turn);
		}

		this.updateCurrent();
	}

	/**
	 * Dock-style magnification driven by pointer proximity, plus the scrub
	 * preview: the tick nearest the pointer previews its turn. Relaxes on leave.
	 */
	magnify(pointerY: number | undefined): void {
		const radius = 22;
		if (pointerY === undefined) {
			for (const tick of this.element.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
				tick.style.transform = '';
				tick.style.background = '';
			}
			this.previewTick = undefined;
			this.closeTimelinePreview();
			return;
		}

		let nearest: HTMLElement | undefined;
		let nearestDistance = Infinity;
		for (const tick of this.element.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
			const rect = tick.getBoundingClientRect();
			const distance = Math.abs(pointerY - (rect.top + rect.height / 2));
			if (distance < nearestDistance) {
				nearestDistance = distance;
				nearest = tick;
			}
			const factor = Math.max(0, 1 - distance / radius);
			tick.style.transform = factor > 0 ? `scaleX(${1 + factor * 3.5})` : '';
			tick.style.background = factor > 0 ? `color-mix(in srgb, var(--vscode-agents-color-text-primary) ${Math.round(22 + factor * 68)}%, transparent)` : '';
		}

		if (nearest && nearest !== this.previewTick) {
			this.previewTick = nearest;
			const turn = this.tickTurns.get(nearest);
			if (turn) {
				this.openTimelinePreview(nearest, turn);
			}
		}
	}

	/** Highlight the tick for the message at the top of the viewport. */
	updateCurrent(): void {
		const rows = this.transcript.querySelectorAll<HTMLElement>('[data-message-id]');
		let currentId: string | undefined;
		const atBottom = this.isNearBottom(8);
		if (atBottom && rows.length > 0) {
			currentId = rows[rows.length - 1]!.dataset.messageId;
		} else {
			const anchor = this.transcript.scrollTop + 48;
			for (const row of rows) {
				if (row.offsetTop <= anchor) {
					currentId = row.dataset.messageId;
				} else {
					break;
				}
			}
		}
		for (const tick of this.element.querySelectorAll<HTMLElement>('.conversation-timeline-tick')) {
			tick.classList.toggle('current', currentId !== undefined && (tick.dataset.blockIds ?? '').split(' ').includes(currentId));
		}
	}

	private isNearBottom(bandPx: number): boolean {
		return this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < bandPx;
	}

	private openTimelinePreview(tick: HTMLElement, turn: ITurn): void {
		this.closeTimelinePreview();

		const card = document.createElement('div');
		card.className = 'conversation-timeline-preview';

		if (turn.user) {
			const title = append(card, document.createElement('div'));
			title.className = 'conversation-timeline-preview-title';
			title.textContent = turn.user.text;
		}

		const excerpt = append(card, document.createElement('div'));
		excerpt.className = 'conversation-timeline-preview-text';
		excerpt.textContent = turn.assistant ? turn.assistant.text.slice(0, 240) : localize('conv.workingEllipsis');

		const files = extractWorkFiles(turn.work);
		if (files.length > 0) {
			const chips = append(card, document.createElement('div'));
			chips.className = 'conversation-timeline-preview-files';
			for (const file of files.slice(0, 3)) {
				const chip = append(chips, document.createElement('span'));
				chip.className = 'conversation-timeline-preview-file';
				const icon = append(chip, document.createElement('span'));
				icon.className = 'codicon codicon-code';
				icon.setAttribute('aria-hidden', 'true');
				const name = append(chip, document.createElement('span'));
				name.className = 'conversation-timeline-preview-file-name';
				name.textContent = file;
			}
			if (files.length > 3) {
				const more = append(chips, document.createElement('span'));
				more.className = 'conversation-timeline-preview-file';
				more.textContent = `+${files.length - 3}`;
			}
		}

		this.host.appendChild(card);
		const viewRect = this.host.getBoundingClientRect();
		const tickRect = tick.getBoundingClientRect();
		const top = Math.min(Math.max(8, tickRect.top - viewRect.top - 12), this.host.clientHeight - card.offsetHeight - 8);
		card.style.top = `${top}px`;
		card.style.left = `${this.element.offsetWidth + 6}px`;
		this.timelinePreview = card;
	}

	closeTimelinePreview(): void {
		this.timelinePreview?.remove();
		this.timelinePreview = undefined;
	}
}

/** File names touched by a work block's write/edit tool steps. */
function extractWorkFiles(work: ISessionMessage | undefined): string[] {
	const files: string[] = [];
	for (const step of work?.steps ?? []) {
		const match = /^(?:write_file|edit_file|read_file) (.+)$/.exec(step.label);
		if (step.kind === 'tool' && match) {
			const name = match[1]!.split('/').pop()!;
			if (!files.includes(name)) {
				files.push(name);
			}
		}
	}
	return files;
}
