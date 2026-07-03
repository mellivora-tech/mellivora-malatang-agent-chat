/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';

export class NewSessionView extends Disposable {
	readonly element: HTMLElement;

	constructor() {
		super();

		this.element = document.createElement('div');
		this.element.className = 'sessions-new-session-view';

		const content = append(this.element, document.createElement('div'));
		content.className = 'new-session-content';

		const heading = append(content, document.createElement('div'));
		heading.className = 'new-session-heading';
		heading.append('New session in ');

		const workspaceButton = append(heading, document.createElement('button')) as HTMLButtonElement;
		workspaceButton.className = 'new-session-workspace-button';
		workspaceButton.type = 'button';
		workspaceButton.title = 'Pick workspace';
		const workspaceIcon = append(workspaceButton, document.createElement('span'));
		workspaceIcon.className = 'codicon codicon-folder';
		workspaceIcon.setAttribute('aria-hidden', 'true');
		const workspaceLabel = append(workspaceButton, document.createElement('span'));
		workspaceLabel.textContent = 'mellivora-malatang';
		const chevron = append(workspaceButton, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-down';
		chevron.setAttribute('aria-hidden', 'true');
		heading.append(' with ');

		const providerButton = append(heading, document.createElement('button')) as HTMLButtonElement;
		providerButton.className = 'new-session-provider-button';
		providerButton.type = 'button';
		providerButton.title = 'Pick agent provider';
		const providerIcon = append(providerButton, document.createElement('span'));
		providerIcon.className = 'codicon codicon-copilot';
		providerIcon.setAttribute('aria-hidden', 'true');
		const providerLabel = append(providerButton, document.createElement('span'));
		providerLabel.textContent = 'Copilot';
		const providerChevron = append(providerButton, document.createElement('span'));
		providerChevron.className = 'codicon codicon-chevron-down';
		providerChevron.setAttribute('aria-hidden', 'true');

		const composer = append(content, document.createElement('form')) as HTMLFormElement;
		composer.className = 'new-session-composer';
		composer.addEventListener('submit', event => event.preventDefault());

		const input = append(composer, document.createElement('textarea')) as HTMLTextAreaElement;
		input.className = 'new-session-input';
		input.rows = 2;
		input.placeholder = "What's your next milestone?";
		input.spellcheck = true;

		const toolbar = append(composer, document.createElement('div'));
		toolbar.className = 'new-session-composer-toolbar';

		const addButton = append(toolbar, document.createElement('button')) as HTMLButtonElement;
		addButton.className = 'new-session-toolbar-button';
		addButton.type = 'button';
		addButton.title = 'Add context';
		addButton.setAttribute('aria-label', 'Add context');
		const addIcon = append(addButton, document.createElement('span'));
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');

		const modelStatus = append(toolbar, document.createElement('div'));
		modelStatus.className = 'new-session-model-status';
		const agentIcon = append(modelStatus, document.createElement('span'));
		agentIcon.className = 'codicon codicon-extensions';
		agentIcon.setAttribute('aria-hidden', 'true');
		const agentText = append(modelStatus, document.createElement('span'));
		agentText.textContent = 'Agent';
		const divider = append(modelStatus, document.createElement('span'));
		divider.className = 'new-session-toolbar-divider';
		const autoText = append(modelStatus, document.createElement('span'));
		autoText.textContent = 'Auto';

		const sendButton = append(composer, document.createElement('button')) as HTMLButtonElement;
		sendButton.className = 'new-session-send-button';
		sendButton.type = 'submit';
		sendButton.title = 'Start session';
		sendButton.setAttribute('aria-label', 'Start session');
		const sendIcon = append(sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-reply';
		sendIcon.setAttribute('aria-hidden', 'true');

		const meta = append(content, document.createElement('div'));
		meta.className = 'new-session-meta-row';

		const approvals = append(meta, document.createElement('div'));
		approvals.className = 'new-session-approvals';
		const approvalsIcon = append(approvals, document.createElement('span'));
		approvalsIcon.className = 'codicon codicon-shield';
		approvalsIcon.setAttribute('aria-hidden', 'true');
		const approvalsText = append(approvals, document.createElement('span'));
		approvalsText.textContent = 'Default Approvals';

		const rightMeta = append(meta, document.createElement('div'));
		rightMeta.className = 'new-session-meta-right';

		const worktree = append(rightMeta, document.createElement('div'));
		worktree.className = 'new-session-worktree';
		const worktreeIcon = append(worktree, document.createElement('span'));
		worktreeIcon.className = 'codicon codicon-git-pull-request';
		worktreeIcon.setAttribute('aria-hidden', 'true');
		const worktreeText = append(worktree, document.createElement('span'));
		worktreeText.textContent = 'Worktree';

		const branch = append(rightMeta, document.createElement('div'));
		branch.className = 'new-session-branch';
		const branchIcon = append(branch, document.createElement('span'));
		branchIcon.className = 'codicon codicon-git-branch';
		branchIcon.setAttribute('aria-hidden', 'true');
		const branchText = append(branch, document.createElement('span'));
		branchText.textContent = 'main';
	}
}
