/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { createDecorator } from '../../../platform/instantiation/instantiation.js';
import type { ISkill, ISkillInput, ISkillsBridge } from '../common/skills.js';

export const ISkillsService = createDecorator<ISkillsService>('skillsService');

export interface ISkillsService {
	readonly skills: IObservable<readonly ISkill[]>;
	initialize(): Promise<void>;
	upsertSkill(input: ISkillInput): Promise<ISkill>;
	deleteSkill(id: string): Promise<void>;
}

import { reportFailure } from '../../../common/diagnostics.js';
export class SkillsService implements ISkillsService {
	private readonly skillsValue = observableValue<readonly ISkill[]>([]);
	readonly skills: IObservable<readonly ISkill[]> = this.skillsValue;

	constructor(private readonly bridge: ISkillsBridge | undefined) {}

	async initialize(): Promise<void> {
		await this.refresh();
	}

	async upsertSkill(input: ISkillInput): Promise<ISkill> {
		if (!this.bridge) {
			throw new Error('Skills are unavailable.');
		}
		const skill = await this.bridge.upsert(input);
		await this.refresh();
		return skill;
	}

	async deleteSkill(id: string): Promise<void> {
		await this.bridge?.delete(id);
		await this.refresh();
	}

	private async refresh(): Promise<void> {
		if (!this.bridge) {
			return;
		}
		try {
			this.skillsValue.set(await this.bridge.list());
		} catch (error) {
			reportFailure('skills.list', error);
		}
	}
}
