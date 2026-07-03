/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { size } from '../base/browser/dom.js';
import { IGridView, LayoutPriority } from '../base/browser/grid.js';
import { Disposable } from '../base/common/lifecycle.js';

export abstract class Part extends Disposable implements IGridView {
	readonly element: HTMLElement;
	abstract readonly minimumWidth: number;
	abstract readonly minimumHeight: number;
	abstract readonly priority: LayoutPriority;

	constructor(
		readonly id: string,
		className: string
	) {
		super();
		this.element = document.createElement('div');
		this.element.className = `part ${className}`;
		this.element.dataset.partId = id;
	}

	create(parent: HTMLElement): void {
		parent.appendChild(this.element);
		this.render(this.element);
	}

	layout(width: number, height: number, top: number, left: number): void {
		size(this.element, width, height);
		this.element.style.top = `${Math.max(0, top)}px`;
		this.element.style.left = `${Math.max(0, left)}px`;
	}

	protected abstract render(container: HTMLElement): void;
}
