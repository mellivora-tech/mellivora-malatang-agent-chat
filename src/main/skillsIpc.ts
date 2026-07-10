/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcMain } from 'electron';
import type { ISkillInput } from '../sessions/services/skills/common/skills.js';
import { deleteSkill, listSkills, upsertSkill } from './skillsStorage.js';

export function registerSkillsIpc(dataRoot: string): void {
	ipcMain.handle('skills:list', () => listSkills(dataRoot));
	ipcMain.handle('skills:upsert', (_event, input: ISkillInput) => upsertSkill(dataRoot, input));
	ipcMain.handle('skills:delete', (_event, id: string) => deleteSkill(dataRoot, id));
}
