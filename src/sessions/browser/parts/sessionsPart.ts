/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { Part } from '../part.js';

export class SessionsPart extends Part {
	readonly minimumWidth = 640;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.High;

	constructor() {
		super('workbench.parts.sessions', 'sessionspart');
	}

	protected render(container: HTMLElement): void {
		container.innerHTML = `
			<div class="part-placeholder">
				<span class="codicon codicon-comment-discussion" aria-hidden="true"></span>
				<span class="part-placeholder-label">Sessions</span>
			</div>
		`;
	}
}
