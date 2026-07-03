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
		heading.append('Start by picking a ');

		const workspaceButton = append(heading, document.createElement('button')) as HTMLButtonElement;
		workspaceButton.className = 'new-session-workspace-button';
		workspaceButton.type = 'button';
		workspaceButton.title = 'Pick workspace';
		const workspaceIcon = append(workspaceButton, document.createElement('span'));
		workspaceIcon.className = 'codicon codicon-window';
		workspaceIcon.setAttribute('aria-hidden', 'true');
		const workspaceLabel = append(workspaceButton, document.createElement('span'));
		workspaceLabel.textContent = 'workspace';
		const chevron = append(workspaceButton, document.createElement('span'));
		chevron.className = 'codicon codicon-chevron-down';
		chevron.setAttribute('aria-hidden', 'true');

		const composer = append(content, document.createElement('form')) as HTMLFormElement;
		composer.className = 'new-session-composer';
		composer.addEventListener('submit', event => event.preventDefault());

		const input = append(composer, document.createElement('textarea')) as HTMLTextAreaElement;
		input.className = 'new-session-input';
		input.rows = 2;
		input.placeholder = 'What are you trying to achieve?';
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
		modelStatus.textContent = 'No models available';

		const sendButton = append(composer, document.createElement('button')) as HTMLButtonElement;
		sendButton.className = 'new-session-send-button';
		sendButton.type = 'submit';
		sendButton.title = 'Start session';
		sendButton.setAttribute('aria-label', 'Start session');
		const sendIcon = append(sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-reply';
		sendIcon.setAttribute('aria-hidden', 'true');
	}
}
