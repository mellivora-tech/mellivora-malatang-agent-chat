/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../base/common/lifecycle.js';
import type { IGitBridge } from '../../services/git/common/git.js';
import type { IProjectsBridge } from '../../services/projects/common/projects.js';
import type { IActiveSession } from '../../services/sessions/common/session.js';
import { ConversationContextBar } from './conversationContextBar.js';

type GitGlobals = typeof globalThis & { readonly agentWindow?: { readonly git?: IGitBridge; readonly projects?: IProjectsBridge } };

export class ConversationContext extends Disposable {
	readonly element: HTMLElement;

	private readonly bar = this._register(new ConversationContextBar('conversation-context-bar'));
	private readonly sessionDisposables = this._register(new DisposableStore());
	private readonly git: IGitBridge | undefined = (globalThis as GitGlobals).agentWindow?.git;
	private readonly projects: IProjectsBridge | undefined = (globalThis as GitGlobals).agentWindow?.projects;
	private session: IActiveSession | undefined;
	private branchCurrent: string | undefined;
	private branchList: readonly string[] = [];
	private branchError: string | undefined;
	private branchMenu: HTMLElement | undefined;
	private closeBranchMenuListeners: (() => void) | undefined;

	constructor() {
		super();
		this.element = this.bar.element;
		this._register(toDisposable(() => this.closeBranchMenu()));
		this.render();
	}

	openSession(session: IActiveSession | undefined): void {
		if (this.session === session) {
			this.render();
			return;
		}

		this.session = session;
		this.sessionDisposables.clear();
		this.branchCurrent = undefined;
		this.branchList = [];
		this.branchError = undefined;

		if (session) {
			this.sessionDisposables.add(session.workspace.subscribe(() => this.render()));
			this.sessionDisposables.add(session.status.subscribe(() => this.render()));
		}

		this.render();
		void this.refreshBranches();
	}

	/** Ask the repository (via the main process) for its real branches. */
	private async refreshBranches(): Promise<void> {
		const session = this.session;
		const projectId = session?.projectId;
		if (!this.git || !session || !projectId) {
			return;
		}
		const result = await this.git.branches(projectId);
		// The active session may have changed while we awaited.
		if (this.session !== session) {
			return;
		}
		this.branchCurrent = result?.current;
		this.branchList = result?.branches ?? [];
		this.render();
	}

	private render(): void {
		// setContent clears the bar, which would orphan an open menu.
		this.closeBranchMenu();

		const header = document.createElement('header');
		header.className = 'conversation-context';

		const left = append(header, document.createElement('div'));
		left.className = 'conversation-context-left';

		const workspace = this.session?.workspace.get();
		const workspacePill = createPill('conversation-context-workspace', 'codicon-folder', workspace?.label ?? 'No workspace');
		// The pill truncates; a custom tooltip reveals the full name (and path)
		// on hover — native title tooltips are unreliable in frameless windows.
		if (workspace) {
			const tooltip = append(workspacePill, document.createElement('span'));
			tooltip.className = 'conversation-context-tooltip';
			tooltip.textContent = workspace.description ? `${workspace.label} — ${workspace.description}` : workspace.label;
		}
		left.appendChild(workspacePill);

		// The branch pill exists only for sessions whose project is a git repo.
		if (this.branchCurrent !== undefined) {
			const branchPill = createPill('conversation-context-branch', 'codicon-git-branch', this.branchCurrent, { chevron: true });
			branchPill.title = this.branchError ?? `Branch: ${this.branchCurrent}`;
			branchPill.classList.toggle('has-error', this.branchError !== undefined);
			branchPill.addEventListener('click', () => this.toggleBranchMenu(branchPill));
			left.appendChild(branchPill);
		}

		const more = append(left, document.createElement('button')) as HTMLButtonElement;
		more.className = 'conversation-context-more';
		more.type = 'button';
		more.title = 'More actions';
		more.setAttribute('aria-label', 'More actions');
		more.addEventListener('click', () => this.toggleMoreMenu(more));

		const moreIcon = append(more, document.createElement('span'));
		moreIcon.className = 'codicon codicon-ellipsis';
		moreIcon.setAttribute('aria-hidden', 'true');

		this.bar.setContent(header);
	}

	private toggleBranchMenu(anchor: HTMLElement): void {
		if (this.branchMenu) {
			this.closeBranchMenu();
			return;
		}

		const menu = document.createElement('div');
		menu.className = 'conversation-branch-menu';
		menu.setAttribute('role', 'menu');

		if (this.branchError !== undefined) {
			const error = append(menu, document.createElement('div'));
			error.className = 'conversation-branch-menu-error';
			error.textContent = this.branchError;
		}

		for (const branch of this.branchList) {
			const item = append(menu, document.createElement('button')) as HTMLButtonElement;
			item.className = 'conversation-branch-menu-item';
			item.type = 'button';
			item.setAttribute('role', 'menuitem');
			const check = append(item, document.createElement('span'));
			check.className = `codicon codicon-check${branch === this.branchCurrent ? '' : ' sessions-model-check-hidden'}`;
			check.setAttribute('aria-hidden', 'true');
			const name = append(item, document.createElement('span'));
			name.className = 'conversation-branch-menu-label';
			name.textContent = branch;
			item.addEventListener('click', () => {
				this.closeBranchMenu();
				void this.checkout(branch);
			});
		}

		// Anchor below the pill, hosted on the bar (the composer clips overflow).
		this.openAnchoredMenu(menu, anchor);
	}

	/** The ⋯ menu. One action today — open the project folder; more to come. */
	private toggleMoreMenu(anchor: HTMLElement): void {
		if (this.branchMenu) {
			this.closeBranchMenu();
			return;
		}

		const projectId = this.session?.projectId;
		const menu = document.createElement('div');
		menu.className = 'conversation-branch-menu';
		menu.setAttribute('role', 'menu');

		const item = append(menu, document.createElement('button')) as HTMLButtonElement;
		item.className = 'conversation-branch-menu-item';
		item.type = 'button';
		item.setAttribute('role', 'menuitem');
		item.disabled = !projectId || !this.projects;
		const icon = append(item, document.createElement('span'));
		icon.className = 'codicon codicon-folder-opened';
		icon.setAttribute('aria-hidden', 'true');
		const label = append(item, document.createElement('span'));
		label.className = 'conversation-branch-menu-label';
		label.textContent = 'Open project folder';
		item.addEventListener('click', () => {
			this.closeBranchMenu();
			if (projectId) {
				void this.projects?.revealInFolder(projectId);
			}
		});

		this.openAnchoredMenu(menu, anchor);
	}

	/** Shared mount/dismiss for the context bar's dropdowns. */
	private openAnchoredMenu(menu: HTMLElement, anchor: HTMLElement): void {
		const host = this.element;
		host.appendChild(menu);
		const hostRect = host.getBoundingClientRect();
		const anchorRect = anchor.getBoundingClientRect();
		// The context bar sits right above the composer at the window bottom, so
		// menus open UPWARD by default (downward would cover the composer and has
		// no room to grow); fall back to below only when the top is cramped.
		const gap = 4;
		const margin = 8;
		const spaceAbove = anchorRect.top - gap - margin;
		const openUp = spaceAbove >= menu.offsetHeight;
		menu.style.top = openUp ? `${anchorRect.top - hostRect.top - menu.offsetHeight - gap}px` : `${anchorRect.bottom - hostRect.top + gap}px`;
		menu.style.left = `${anchorRect.left - hostRect.left}px`;

		const onOutsideMouseDown = (event: MouseEvent): void => {
			if (event.target instanceof Node && !menu.contains(event.target) && !anchor.contains(event.target)) {
				this.closeBranchMenu();
			}
		};
		const onEscape = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				this.closeBranchMenu();
			}
		};
		document.addEventListener('mousedown', onOutsideMouseDown, true);
		document.addEventListener('keydown', onEscape, true);
		this.branchMenu = menu;
		this.closeBranchMenuListeners = () => {
			document.removeEventListener('mousedown', onOutsideMouseDown, true);
			document.removeEventListener('keydown', onEscape, true);
		};
	}

	private closeBranchMenu(): void {
		this.branchMenu?.remove();
		this.branchMenu = undefined;
		this.closeBranchMenuListeners?.();
		this.closeBranchMenuListeners = undefined;
	}

	private async checkout(branch: string): Promise<void> {
		const session = this.session;
		const projectId = session?.projectId;
		if (!this.git || !session || !projectId || branch === this.branchCurrent) {
			return;
		}
		const result = await this.git.checkout(projectId, branch);
		if (this.session !== session) {
			return;
		}
		if (result.ok) {
			this.branchCurrent = result.current;
			this.branchError = undefined;
		} else {
			// Keep the old branch on screen; the pill's tooltip carries the reason.
			this.branchError = result.error;
		}
		this.render();
	}
}

function createPill(className: string, iconClass: string, labelText: string, options?: { readonly chevron?: boolean }): HTMLElement {
	const pill = document.createElement('button');
	pill.className = `conversation-context-pill ${className}`;
	pill.type = 'button';

	const icon = append(pill, document.createElement('span'));
	icon.className = `codicon ${iconClass}`;
	icon.setAttribute('aria-hidden', 'true');

	const label = append(pill, document.createElement('span'));
	label.textContent = labelText;

	// Only interactive pills get the dropdown affordance.
	if (options?.chevron) {
		const chevron = append(pill, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-down';
		chevron.setAttribute('aria-hidden', 'true');
	}

	return pill;
}
