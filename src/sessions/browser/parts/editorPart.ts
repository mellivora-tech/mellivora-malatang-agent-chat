/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { Part } from '../part.js';

export class EditorPart extends Part {
	readonly minimumWidth = 320;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Normal;

	constructor() {
		super('workbench.parts.editor', 'editor');
	}

	protected render(container: HTMLElement): void {
		container.innerHTML = `
			<div class="part-placeholder">
				<span class="codicon codicon-file-code" aria-hidden="true"></span>
				<span class="part-placeholder-label">Editor</span>
			</div>
		`;
	}
}
