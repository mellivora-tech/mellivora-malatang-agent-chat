/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface IAction {
	readonly id: string;
	readonly label: string;
	readonly icon?: string;
	readonly enabled?: boolean;
	run(): void | Promise<void>;
}

export class MenuId {
	static readonly TitleBarLeft = new MenuId('TitleBarLeft');
	static readonly CommandCenter = new MenuId('CommandCenter');
	static readonly TitleBarRight = new MenuId('TitleBarRight');
	static readonly SidebarTitle = new MenuId('SidebarTitle');
	static readonly SessionHeaderTitle = new MenuId('SessionHeaderTitle');
	static readonly AuxiliaryBarTitle = new MenuId('AuxiliaryBarTitle');

	constructor(readonly id: string) {
	}
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
