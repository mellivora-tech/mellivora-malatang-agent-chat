/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerHandler } from './ipcObservability.js';
import type { ISkillInput } from '../sessions/services/skills/common/skills.js';
import { deleteSkill, listSkills, upsertSkill } from './skillsStorage.js';

export function registerSkillsIpc(dataRoot: string): void {
	registerHandler('skills:list', () => listSkills(dataRoot));
	registerHandler('skills:upsert', (_event, input: ISkillInput) => upsertSkill(dataRoot, input));
	registerHandler('skills:delete', (_event, id: string) => deleteSkill(dataRoot, id));
}
