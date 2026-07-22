/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { instrumentHandler } from './ipcInstrument.js';

/**
 * A drop-in replacement for `ipcMain.handle` that gives every IPC channel a
 * durable failure trace. This module is the thin electron binding; the timing,
 * classification and emit logic lives in ipcInstrument.ts so it stays testable
 * without electron. See that file for why a wrapper — rather than per-handler
 * try/catch or a global rejection hook — is the seam that works.
 */
export function registerHandler<TArgs extends unknown[], TResult>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>): void {
	const instrumented = instrumentHandler<[IpcMainInvokeEvent, ...TArgs], TResult>(channel, listener);
	ipcMain.handle(channel, async (event, ...args) => instrumented(event, ...(args as TArgs)));
}
