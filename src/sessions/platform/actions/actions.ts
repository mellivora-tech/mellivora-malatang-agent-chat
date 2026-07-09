/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IAction } from '../../base/common/actions.js';

export type { IAction } from '../../base/common/actions.js';

export class MenuId {
	static readonly TitleBarLeft = new MenuId('TitleBarLeft');
	static readonly CommandCenter = new MenuId('CommandCenter');
	static readonly TitleBarRight = new MenuId('TitleBarRight');
	static readonly SidebarTitle = new MenuId('SidebarTitle');
	static readonly ConversationContextTitle = new MenuId('ConversationContextTitle');
	static readonly AuxiliaryBarTitle = new MenuId('AuxiliaryBarTitle');

	constructor(readonly id: string) {}
}

const menuActions = new Map<string, IAction[]>();

export function registerAction(menu: MenuId, action: IAction): void {
	const existing = menuActions.get(menu.id);
	if (!existing) {
		menuActions.set(menu.id, [action]);
		return;
	}

	const index = existing.findIndex(candidate => candidate.id === action.id);
	if (index >= 0) {
		existing.splice(index, 1, action);
		return;
	}

	existing.push(action);
}

export function getMenuActions(menu: MenuId): readonly IAction[] {
	return menuActions.get(menu.id) ?? [];
}
