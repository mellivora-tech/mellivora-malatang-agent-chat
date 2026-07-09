/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { clearNode } from '../../base/browser/dom.js';
import { Disposable } from '../../base/common/lifecycle.js';

export class ConversationContextBar extends Disposable {
	readonly element: HTMLElement;

	constructor(className: string) {
		super();
		this.element = document.createElement('div');
		this.element.className = className;
	}

	setContent(...children: Node[]): void {
		clearNode(this.element);
		this.element.append(...children);
	}
}
