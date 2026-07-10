/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Skill contracts shared between the main process (which stores skills as
 * markdown files under dataRoot/skills/) and the renderer. A skill is a
 * reusable instruction snippet: `$name` in the composer attaches it to the
 * message, and its body rides the run's system prompt.
 */

export interface ISkill {
	/** Stable slug — the filename and what `$mentions` record. */
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

export interface ISkillInput {
	/** Present when editing; absent when creating (the id is derived from the name). */
	readonly id?: string;
	readonly name: string;
	readonly description: string;
	readonly body: string;
}

/** The shape exposed on `agentWindow.skills` by the preload script. */
export interface ISkillsBridge {
	list(): Promise<readonly ISkill[]>;
	upsert(input: ISkillInput): Promise<ISkill>;
	delete(id: string): Promise<void>;
}
