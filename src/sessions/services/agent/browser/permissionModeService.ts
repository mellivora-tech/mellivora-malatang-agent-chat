/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
	{ mode: 'ask', label: 'Ask before changes', description: 'Ask before file changes.', icon: 'codicon-shield' },
	{ mode: 'auto-edit', label: 'Edit automatically', description: 'Edit files automatically.', icon: 'codicon-edit' },
	{ mode: 'plan', label: 'Plan mode', description: 'Plan before editing.', icon: 'codicon-checklist' },
	{ mode: 'full', label: 'Full access', description: 'Run with fewer confirmations.', icon: 'codicon-unlock' },
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
