/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LayoutPriority } from '../../base/browser/grid.js';
import { Part } from '../part.js';

export class AuxiliaryBarPart extends Part {
	readonly minimumWidth = 260;
	readonly minimumHeight = 0;
	readonly priority = LayoutPriority.Low;

	constructor() {
		super('workbench.parts.auxiliarybar', 'auxiliarybar');
	}

	protected render(container: HTMLElement): void {
		container.innerHTML = `
			<div class="part-placeholder">
				<span class="codicon codicon-layout-sidebar-right" aria-hidden="true"></span>
				<span class="part-placeholder-label">Auxiliary Bar</span>
			</div>
		`;
	}
}
