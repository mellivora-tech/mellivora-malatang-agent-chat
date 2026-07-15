/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../common/i18n/i18n.js';
import { observableValue } from '../../../base/common/observable.js';
import type { PermissionMode } from '../common/agent.js';

export interface IPermissionModeInfo {
	readonly mode: PermissionMode;
	readonly label: string;
	readonly description: string;
	readonly icon: string;
}

/** Composer menu entries, in display order. */
export const PERMISSION_MODES: readonly IPermissionModeInfo[] = [
	{ mode: 'ask', label: localize('perm.ask'), description: localize('perm.ask.desc'), icon: 'codicon-shield' },
	{ mode: 'auto-edit', label: localize('perm.autoEdit'), description: localize('perm.autoEdit.desc'), icon: 'codicon-edit' },
	{ mode: 'plan', label: localize('perm.plan'), description: localize('perm.plan.desc'), icon: 'codicon-checklist' },
	{ mode: 'full', label: localize('perm.full'), description: localize('perm.full.desc'), icon: 'codicon-unlock' },
];

export function permissionModeInfo(mode: PermissionMode): IPermissionModeInfo {
	return PERMISSION_MODES.find(info => info.mode === mode) ?? PERMISSION_MODES[0]!;
}

/**
 * The app-wide permission mode driving every run's gate. One observable shared
 * by all composers (a per-session mode can layer on top later); defaults to the
 * safe 'ask'.
 */
export const permissionMode = observableValue<PermissionMode>('ask');
