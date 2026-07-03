/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append, clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';

export class ChatCompositeBar extends Disposable {
	readonly element: HTMLElement;

	constructor(className: string) {
		super();
		this.element = document.createElement('div');
		this.element.className = `chat-composite-bar ${className}`;
	}

	setContent(...children: Node[]): void {
		clearNode(this.element);
		this.element.append(...children);
	}
}

export function createCompositeAction(label: string, codicon: string, title = label): HTMLButtonElement {
	const button = document.createElement('button');
	button.className = 'chat-composite-bar-action';
	button.type = 'button';
	button.title = title;

	const icon = append(button, document.createElement('span'));
	icon.className = `codicon ${codicon}`;
	icon.setAttribute('aria-hidden', 'true');

	const text = append(button, document.createElement('span'));
	text.className = 'chat-composite-bar-action-label';
	text.textContent = label;

	return button;
}
