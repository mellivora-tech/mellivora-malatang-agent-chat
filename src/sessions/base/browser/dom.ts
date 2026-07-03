/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, Emitter } from '../common/event.js';

export function $(className: string, tagName: keyof HTMLElementTagNameMap = 'div'): HTMLElement {
	const element = document.createElement(tagName);
	const classes = className
		.split(/[\s.]+/)
		.map(token => token.trim())
		.filter(token => token.length > 0);

	if (classes.length > 0) {
		element.classList.add(...classes);
	}

	return element;
}

export function append<T extends HTMLElement>(parent: HTMLElement, child: T): T {
	parent.appendChild(child);
	return child;
}

export function clearNode(node: HTMLElement): void {
	node.replaceChildren();
}

export function size(node: HTMLElement, width: number, height: number): void {
	node.style.width = `${Math.max(0, width)}px`;
	node.style.height = `${Math.max(0, height)}px`;
}

export function trackFocus(node: HTMLElement): { onDidFocus: Event<FocusEvent>; onDidBlur: Event<FocusEvent>; dispose(): void } {
	const onDidFocus = new Emitter<FocusEvent>();
	const onDidBlur = new Emitter<FocusEvent>();

	const focusListener = (event: FocusEvent) => {
		onDidFocus.fire(event);
	};
	const blurListener = (event: FocusEvent) => {
		onDidBlur.fire(event);
	};

	node.addEventListener('focus', focusListener, true);
	node.addEventListener('blur', blurListener, true);

	return {
		onDidFocus: onDidFocus.event,
		onDidBlur: onDidBlur.event,
		dispose(): void {
			node.removeEventListener('focus', focusListener, true);
			node.removeEventListener('blur', blurListener, true);
			onDidFocus.dispose();
			onDidBlur.dispose();
		}
	};
}
