/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { ISessionPendingApproval } from '../../services/sessions/common/session.js';

export interface IApprovalDockOptions {
	/** Called when the dock empties and held focus; return true to move focus to the composer input. */
	readonly shouldFocusComposer: () => boolean;
	/** Focus the composer input (only called when shouldFocusComposer returns true). */
	readonly focusComposer: () => void;
}

/**
 * The docked approval strip above the composer. Pending tool approvals stack
 * here; the view renders only when the request set changes so typed deny
 * reasons and focus survive the 1s work ticker. Extracted from
 * ConversationView to isolate approval card DOM building and density logic.
 */
export class ApprovalDock extends Disposable {
	readonly element: HTMLElement;
	/** The approval request whose Allow button already got initial focus (re-render guard). */
	private focusedApprovalId: string | undefined;
	/** requestIds currently materialized in the dock — the DOM (typed reason text,
	 *  focus) survives renders whose approval set is unchanged. */
	private renderedApprovalKey = '';
	/** Approval request ids seen per session — drives the compact-density switch. */
	private readonly approvalsSeen = new Map<string, Set<string>>();

	constructor() {
		super();
		this.element = document.createElement('div');
		this.element.className = 'conversation-approval-dock';
		this.element.setAttribute('role', 'region');
		this.element.setAttribute('aria-label', localize('appr.dockAria'));
		this.element.hidden = true;
	}

	/**
	 * Rebuild the docked approval strip — but ONLY when the set of pending
	 * requests actually changed: the caller also fires for the 1s work ticker,
	 * and rebuilding then would wipe a half-typed deny reason and the focus.
	 */
	render(approvals: readonly ISessionPendingApproval[], sessionId: string | undefined, options: IApprovalDockOptions): void {
		const key = approvals.map(approval => approval.requestId).join('\n');
		if (key === this.renderedApprovalKey) {
			return;
		}
		this.renderedApprovalKey = key;

		const previousReasons = new Map<string, string>();
		let refocusReasonId: string | undefined;
		for (const card of this.element.querySelectorAll<HTMLElement>('.conversation-approval')) {
			const requestId = card.dataset['requestId'];
			const reasonInput = card.querySelector<HTMLInputElement>('.conversation-approval-reason');
			if (requestId !== undefined && reasonInput) {
				if (reasonInput.value !== '') {
					previousReasons.set(requestId, reasonInput.value);
				}
				if (reasonInput === document.activeElement) {
					refocusReasonId = requestId;
				}
			}
		}
		const hadFocus = this.element.contains(document.activeElement);

		clearNode(this.element);
		this.element.hidden = approvals.length === 0;
		if (approvals.length === 0) {
			this.focusedApprovalId = undefined;
			if (hadFocus && options.shouldFocusComposer()) {
				options.focusComposer();
			}
			return;
		}

		approvals.forEach((approval, index) => {
			const compact = this.useCompactApproval(approval, sessionId) || (index > 0 && shouldRenderCompactApproval(COMPACT_APPROVAL_AFTER, approval.toolName));
			const card = createApprovalCard(approval, compact);
			this.element.appendChild(card);
			const carriedReason = previousReasons.get(approval.requestId);
			const reasonInput = card.querySelector<HTMLInputElement>('.conversation-approval-reason');
			if (carriedReason !== undefined && reasonInput) {
				reasonInput.value = carriedReason;
			}
			if (approval.requestId === refocusReasonId) {
				reasonInput?.focus();
			}
		});

		const first = approvals[0]!;
		if ((first.requestId !== this.focusedApprovalId || hadFocus) && refocusReasonId === undefined && !options.shouldFocusComposer()) {
			this.element.querySelector<HTMLButtonElement>('.conversation-approval-allow')?.focus();
		}
		this.focusedApprovalId = first.requestId;
	}

	/** Count this request against its session and decide the card's density. */
	private useCompactApproval(approval: ISessionPendingApproval, sessionId: string | undefined): boolean {
		if (sessionId === undefined) {
			return false;
		}
		let seen = this.approvalsSeen.get(sessionId);
		if (!seen) {
			seen = new Set();
			this.approvalsSeen.set(sessionId, seen);
		}
		const prior = seen.has(approval.requestId) ? seen.size - 1 : seen.size;
		seen.add(approval.requestId);
		return shouldRenderCompactApproval(prior, approval.toolName);
	}
}

/** Full cards a session answers before the density drops to compact single-row. */
const COMPACT_APPROVAL_AFTER = 3;

/**
 * Whether an approval renders as the compact single-row variant: once a session
 * has already been through a few full cards, later prompts shrink to one line so
 * an approval-dense run stops eating the transcript. Only tools with a guard
 * BEHIND the prompt (bash sandbox, file-tool code root) may shrink —
 * run_on_server's only gate is the prompt itself, so it always gets the full card.
 */
export function shouldRenderCompactApproval(priorPrompts: number, toolName: string): boolean {
	if (toolName !== 'bash' && toolName !== 'write_file' && toolName !== 'edit_file') {
		return false;
	}
	return priorPrompts >= COMPACT_APPROVAL_AFTER;
}

/** Per-tool presentation of an approval prompt: icon, human title, type chip, and how to show the detail. */
function describeApproval(toolName: string, detail: string): { icon: string; title: string; chip: string; command?: string; path?: string } {
	switch (toolName) {
		case 'bash':
			return { icon: 'codicon-terminal', title: localize('appr.runCommand'), chip: 'bash', command: detail };
		case 'write_file':
			return { icon: 'codicon-new-file', title: localize('appr.writeFile'), chip: 'write_file', path: detail.replace(/^write /, '') };
		case 'edit_file':
			return { icon: 'codicon-edit', title: localize('appr.editFile'), chip: 'edit_file', path: detail.replace(/^edit /, '') };
		case 'execute_data_source':
			return { icon: 'codicon-database', title: localize('appr.executeDataSource'), chip: 'execute_data_source', command: detail };
		default:
			return { icon: 'codicon-shield', title: localize('appr.generic'), chip: toolName };
	}
}

/** Muted-dir + bold-filename path spans, shared by the full and compact bodies. */
function appendApprovalPath(row: HTMLElement, path: string): void {
	const slash = path.lastIndexOf('/');
	if (slash >= 0) {
		const dir = append(row, document.createElement('span'));
		dir.className = 'conversation-approval-path-dir';
		dir.textContent = path.slice(0, slash + 1);
	}
	const base = append(row, document.createElement('span'));
	base.className = 'conversation-approval-path-base';
	base.textContent = slash >= 0 ? path.slice(slash + 1) : path;
}

/** The card's typed-but-not-sent deny reason, if any. */
function readDenyReason(card: HTMLElement): string | undefined {
	const value = card.querySelector<HTMLInputElement>('.conversation-approval-reason')?.value.trim();
	return value === undefined || value === '' ? undefined : value;
}

/** Trailing kbd hint (⏎ / Esc) — the ALTERNATE way to fire a row, not its
 *  identity, so it stays a quiet chip pinned to the row's far right. */
function appendKeyHint(button: HTMLElement, text: string): void {
	const key = append(button, document.createElement('kbd'));
	key.className = 'conversation-approval-key';
	key.textContent = text;
}

/** Leading row number (Antigravity's plain "1  2  3" list column) — the row's
 *  PRIMARY identity, so it renders as plain muted text, not a boxed chip. */
function appendActionIndex(button: HTMLElement, digit: string): void {
	const index = append(button, document.createElement('span'));
	index.className = 'conversation-approval-action-index';
	index.textContent = digit;
}

/**
 * Allow / always-allow / deny row. Full cards render as a plain numbered
 * list — one full-width row per option, the leading digit its identity,
 * hover/focus painting the whole row (a lighter, less "button toolbar" read
 * than the compact card's pills). Compact keeps the pill row unchanged: a
 * dense single line has no room for a spacious list.
 *
 * Digit hints number whatever ACTUALLY renders (1..N in DOM order) — a tool
 * with no grant (execute_data_source, run_on_server) only gets Allow + Deny,
 * so those must read "1 / 2", never "1 / 4" with two phantom slots in between.
 */
function appendApprovalActions(card: HTMLElement, approval: ISessionPendingApproval, compact: boolean): void {
	const actions = append(card, document.createElement('div'));
	actions.className = 'conversation-approval-actions';
	let nextDigit = 1;
	const digitHint = (): string => String(nextDigit++);

	const allow = append(actions, document.createElement('button')) as HTMLButtonElement;
	allow.className = 'conversation-approval-allow';
	allow.type = 'button';
	if (!compact) {
		appendActionIndex(allow, digitHint());
	}
	append(allow, document.createElement('span')).textContent = localize('appr.allow');
	if (!compact) {
		appendKeyHint(allow, '⏎');
	}
	allow.addEventListener('click', () => approval.respond(true));

	if (approval.alwaysAllow !== undefined) {
		const always = append(actions, document.createElement('button')) as HTMLButtonElement;
		always.className = 'conversation-approval-always';
		always.type = 'button';
		always.title = localize('appr.alwaysTitle', approval.alwaysAllow);
		if (!compact) {
			appendActionIndex(always, digitHint());
		}
		append(always, document.createElement('span')).textContent = localize('appr.always');
		const pattern = append(always, document.createElement('code'));
		pattern.className = 'conversation-approval-pattern';
		pattern.textContent = approval.alwaysAllow;
		always.addEventListener('click', () => approval.respond(true, true, 'session'));

		if (approval.alwaysAllowProject && !compact) {
			const forever = append(actions, document.createElement('button')) as HTMLButtonElement;
			forever.className = 'conversation-approval-always conversation-approval-always-project';
			forever.type = 'button';
			forever.title = localize('appr.projectTitle', approval.alwaysAllow);
			appendActionIndex(forever, digitHint());
			append(forever, document.createElement('span')).textContent = localize('appr.project');
			forever.addEventListener('click', () => approval.respond(true, true, 'project'));
		}
	}

	const deny = append(actions, document.createElement('button')) as HTMLButtonElement;
	deny.className = 'conversation-approval-deny';
	deny.type = 'button';
	if (!compact) {
		appendActionIndex(deny, digitHint());
	}
	append(deny, document.createElement('span')).textContent = localize('appr.deny');
	if (!compact) {
		appendKeyHint(deny, 'Esc');
	}
	deny.addEventListener('click', () => approval.respond(false, undefined, undefined, readDenyReason(card)));
}

function createApprovalCard(approval: ISessionPendingApproval, compact = false): HTMLElement {
	const card = document.createElement('div');
	card.className = compact ? 'conversation-approval conversation-approval-compact' : 'conversation-approval';
	card.dataset['requestId'] = approval.requestId;
	card.setAttribute('role', 'alertdialog');
	card.setAttribute('aria-label', localize('appr.aria'));
	card.addEventListener('keydown', event => {
		if (event.isComposing) {
			return;
		}
		if (event.key === 'Escape') {
			event.preventDefault();
			approval.respond(false);
			return;
		}
		const inReason = event.target instanceof HTMLInputElement && event.target.classList.contains('conversation-approval-reason');
		if (inReason) {
			if (event.key === 'Enter') {
				event.preventDefault();
				const reason = readDenyReason(card);
				if (reason !== undefined) {
					approval.respond(false, undefined, undefined, reason);
				}
			}
			return;
		}
		const digit = Number(event.key);
		if (Number.isInteger(digit) && digit >= 1) {
			const button = card.querySelectorAll<HTMLButtonElement>('.conversation-approval-actions button')[digit - 1];
			if (button) {
				event.preventDefault();
				button.click();
			}
		}
	});

	const spec = describeApproval(approval.toolName, approval.detail);

	if (compact) {
		appendCodicon(card, spec.icon);
		const body = append(card, document.createElement('span'));
		body.className = 'conversation-approval-compact-detail';
		body.title = spec.command ?? spec.path ?? approval.detail;
		if (spec.command !== undefined) {
			const marker = append(body, document.createElement('span'));
			marker.className = 'conversation-approval-prompt';
			marker.textContent = '$';
			const cmd = append(body, document.createElement('code'));
			cmd.className = 'conversation-approval-compact-command';
			cmd.textContent = spec.command;
		} else if (spec.path !== undefined) {
			appendApprovalPath(body, spec.path);
		} else {
			const detail = append(body, document.createElement('code'));
			detail.className = 'conversation-approval-compact-command';
			detail.textContent = approval.detail;
		}
		appendApprovalActions(card, approval, true);
		return card;
	}

	const header = append(card, document.createElement('div'));
	header.className = 'conversation-approval-header';
	appendCodicon(header, spec.icon);
	const title = append(header, document.createElement('span'));
	title.className = 'conversation-approval-title';
	title.textContent = spec.title;
	const chip = append(header, document.createElement('span'));
	chip.className = 'conversation-approval-chip';
	chip.textContent = spec.chip;

	if (spec.command !== undefined) {
		const term = append(card, document.createElement('div'));
		term.className = 'conversation-approval-terminal';
		const marker = append(term, document.createElement('span'));
		marker.className = 'conversation-approval-prompt';
		marker.textContent = '$';
		const cmd = append(term, document.createElement('code'));
		cmd.className = 'conversation-approval-command';
		cmd.textContent = spec.command;
	} else if (spec.path !== undefined) {
		const row = append(card, document.createElement('div'));
		row.className = 'conversation-approval-path';
		appendCodicon(row, 'codicon-file');
		appendApprovalPath(row, spec.path);
	} else {
		const detail = append(card, document.createElement('code'));
		detail.className = 'conversation-approval-command';
		detail.textContent = approval.detail;
	}

	appendApprovalActions(card, approval, false);

	const reason = append(card, document.createElement('input')) as HTMLInputElement;
	reason.className = 'conversation-approval-reason';
	reason.type = 'text';
	reason.placeholder = localize('appr.reasonPlaceholder');
	reason.setAttribute('aria-label', localize('appr.reasonPlaceholder'));

	return card;
}

function appendCodicon(parent: HTMLElement, codicon: string): HTMLElement {
	const icon = append(parent, document.createElement('span'));
	icon.className = `codicon ${codicon}`;
	icon.setAttribute('aria-hidden', 'true');
	return icon;
}
