/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';

export interface INewSessionViewOptions {
	readonly onStartSession?: (query: string) => Promise<unknown>;
}

export class NewSessionView extends Disposable {
	readonly element: HTMLElement;

	constructor(private readonly options: INewSessionViewOptions = {}) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'sessions-new-session-view';

		const content = append(this.element, document.createElement('div'));
		content.className = 'new-session-content';

		const watermark = append(content, document.createElement('div'));
		watermark.className = 'new-session-watermark';
		watermark.setAttribute('aria-hidden', 'true');

		const heading = append(content, document.createElement('h1'));
		heading.className = 'new-session-heading';
		heading.textContent = 'Morning, how can I help?';

		const composer = append(content, document.createElement('form')) as HTMLFormElement;
		composer.className = 'new-session-composer';

		const context = append(composer, document.createElement('button')) as HTMLButtonElement;
		context.className = 'new-session-composer-context';
		context.type = 'button';
		context.title = 'Pick project';
		const contextIcon = append(context, document.createElement('span'));
		contextIcon.className = 'codicon codicon-folder';
		contextIcon.setAttribute('aria-hidden', 'true');
		const contextLabel = append(context, document.createElement('span'));
		contextLabel.textContent = 'Obsidian';
		const contextChevron = append(context, document.createElement('span'));
		contextChevron.className = 'codicon codicon-chevron-down';
		contextChevron.setAttribute('aria-hidden', 'true');

		const input = append(composer, document.createElement('textarea')) as HTMLTextAreaElement;
		input.className = 'new-session-input';
		input.rows = 2;
		input.placeholder = 'Ask ZCode anything, @ for files, folders, or whiteboards, / for commands or agents, $ for skills, # for related conversations';
		input.spellcheck = true;

		const toolbar = append(composer, document.createElement('div'));
		toolbar.className = 'new-session-composer-toolbar';

		const leftControls = append(toolbar, document.createElement('div'));
		leftControls.className = 'new-session-toolbar-left';

		const addButton = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		addButton.className = 'new-session-toolbar-button';
		addButton.type = 'button';
		addButton.title = 'Add context';
		addButton.setAttribute('aria-label', 'Add context');
		const addIcon = append(addButton, document.createElement('span'));
		addIcon.className = 'codicon codicon-add';
		addIcon.setAttribute('aria-hidden', 'true');

		const access = append(leftControls, document.createElement('button')) as HTMLButtonElement;
		access.className = 'new-session-access';
		access.type = 'button';
		access.title = 'Approvals';
		const accessIcon = append(access, document.createElement('span'));
		accessIcon.className = 'codicon codicon-shield';
		accessIcon.setAttribute('aria-hidden', 'true');
		const accessLabel = append(access, document.createElement('span'));
		accessLabel.textContent = 'Full access';
		const accessChevron = append(access, document.createElement('span'));
		accessChevron.className = 'codicon codicon-chevron-down';
		accessChevron.setAttribute('aria-hidden', 'true');

		const rightControls = append(toolbar, document.createElement('div'));
		rightControls.className = 'new-session-toolbar-right';

		const model = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		model.className = 'new-session-model';
		model.type = 'button';
		model.title = 'Pick model';
		const modelIndicator = append(model, document.createElement('span'));
		modelIndicator.className = 'new-session-model-indicator';
		modelIndicator.setAttribute('aria-hidden', 'true');
		const modelLabel = append(model, document.createElement('span'));
		modelLabel.textContent = 'GLM-5.2';
		const modelChevron = append(model, document.createElement('span'));
		modelChevron.className = 'codicon codicon-chevron-down';
		modelChevron.setAttribute('aria-hidden', 'true');

		const agent = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		agent.className = 'new-session-agent';
		agent.type = 'button';
		agent.title = 'Pick agent';
		const agentIcon = append(agent, document.createElement('span'));
		agentIcon.className = 'codicon codicon-github-alt';
		agentIcon.setAttribute('aria-hidden', 'true');
		const agentLabel = append(agent, document.createElement('span'));
		agentLabel.textContent = 'Max';
		const agentChevron = append(agent, document.createElement('span'));
		agentChevron.className = 'codicon codicon-chevron-down';
		agentChevron.setAttribute('aria-hidden', 'true');

		const sendButton = append(rightControls, document.createElement('button')) as HTMLButtonElement;
		sendButton.className = 'new-session-send-button';
		sendButton.type = 'submit';
		sendButton.title = 'Start session';
		sendButton.setAttribute('aria-label', 'Start session');
		const sendIcon = append(sendButton, document.createElement('span'));
		sendIcon.className = 'codicon codicon-arrow-up';
		sendIcon.setAttribute('aria-hidden', 'true');

		composer.addEventListener('submit', event => {
			event.preventDefault();
			const query = input.value.trim();
			if (!query) {
				input.focus();
				return;
			}

			input.value = '';
			void this.options.onStartSession?.(query);
		});
	}
}
