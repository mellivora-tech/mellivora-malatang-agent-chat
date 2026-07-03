/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAction } from '../../../common/actions.js';
import { Disposable } from '../../../common/lifecycle.js';
import { ActionBar, type IActionBarOptions } from '../actionbar/actionbar.js';

export interface IToolBarOptions extends IActionBarOptions {
	readonly extraClassName?: string;
}

export class ToolBar extends Disposable {
	readonly element: HTMLElement;
	private readonly actionBar: ActionBar;

	constructor(container: HTMLElement, options: IToolBarOptions = {}) {
		super();

		this.element = document.createElement('div');
		this.element.className = 'monaco-toolbar';
		if (options.extraClassName) {
			this.element.classList.add(options.extraClassName);
		}
		container.appendChild(this.element);

		this.actionBar = this._register(new ActionBar(this.element, options));
	}

	setActions(actions: readonly IAction[]): void {
		this.actionBar.clear();
		for (const action of actions) {
			this.actionBar.push(action);
		}
	}

	setActionContext(context: unknown): void {
		this.actionBar.setActionContext(context);
	}
}
