/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from './event.js';
import { Disposable } from './lifecycle.js';

export interface IAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly class?: string;
	readonly keybinding?: string;
	readonly tooltip?: string;
	readonly enabled?: boolean;
	run(context?: unknown): void | Promise<void>;
}

export interface IRunEvent {
	readonly action: IAction;
	readonly context?: unknown;
	readonly error?: unknown;
}

export interface IActionRunner {
	readonly onDidRun: Event<IRunEvent>;
	readonly onWillRun: Event<IRunEvent>;
	run(action: IAction, context?: unknown): Promise<void>;
}

export class ActionRunner extends Disposable implements IActionRunner {
	private readonly onDidRunEmitter = this._register(new Emitter<IRunEvent>());
	private readonly onWillRunEmitter = this._register(new Emitter<IRunEvent>());

	readonly onDidRun = this.onDidRunEmitter.event;
	readonly onWillRun = this.onWillRunEmitter.event;

	async run(action: IAction, context?: unknown): Promise<void> {
		if (action.enabled === false) {
			return;
		}

		this.onWillRunEmitter.fire({ action, ...(context !== undefined ? { context } : {}) });

		try {
			await action.run(context);
			this.onDidRunEmitter.fire({ action, ...(context !== undefined ? { context } : {}) });
		} catch (error) {
			this.onDidRunEmitter.fire({ action, ...(context !== undefined ? { context } : {}), error });
			throw error;
		}
	}
}
