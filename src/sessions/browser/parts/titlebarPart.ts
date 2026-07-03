/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { Part } from '../part.js';

export class TitlebarPart extends Part {
	readonly minimumWidth = 0;
	readonly minimumHeight = 35;
	readonly priority = LayoutPriority.Low;

	constructor() {
		super('workbench.parts.titlebar', 'titlebar');
	}

	protected render(container: HTMLElement): void {
		container.innerHTML = `
			<div class="part-placeholder part-placeholder-titlebar">
				<span class="codicon codicon-layout-panel" aria-hidden="true"></span>
				<span class="part-placeholder-label">Title Bar</span>
			</div>
		`;
	}
}
