/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Project instructions (AGENTS.md / CLAUDE.md at the workspace root) are
 * injected into the system prompt deterministically — relying on the model to
 * think of reading them is luck, not design (observed: it worked once in the
 * gw workspace purely because the model happened to explore them).
 *
 * v1 scope is the project root only, first match wins (opencode's rule: don't
 * stack instructions from every ancestor). The 40K-char cap matches Claude
 * Code's MAX_MEMORY_CHARACTER_COUNT. Deeper features — nested AGENTS.md for
 * subdirectories, @-includes, rules folders — are deliberately out of scope.
 */
const CANDIDATE_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;
const MAX_INSTRUCTION_CHARS = 40_000;

export interface IProjectInstructions {
	readonly file: string;
	readonly text: string;
	readonly truncated: boolean;
}

/** Kill switch: AGENT_CHAT_PROJECT_INSTRUCTIONS=off (same pattern as the guards). */
export function isProjectInstructionsEnabled(env: NodeJS.ProcessEnv): boolean {
	return env['AGENT_CHAT_PROJECT_INSTRUCTIONS'] !== 'off';
}

/** The first readable, non-empty candidate at the workspace root; undefined when none. */
export async function loadProjectInstructions(cwd: string): Promise<IProjectInstructions | undefined> {
	for (const file of CANDIDATE_FILES) {
		let raw: string;
		try {
			raw = await readFile(join(cwd, file), 'utf8');
		} catch {
			continue;
		}
		const text = raw.trim();
		if (text === '') {
			continue;
		}
		if (text.length > MAX_INSTRUCTION_CHARS) {
			return { file, text: `${text.slice(0, MAX_INSTRUCTION_CHARS)}\n[instructions truncated at ${MAX_INSTRUCTION_CHARS} chars]`, truncated: true };
		}
		return { file, text, truncated: false };
	}
	return undefined;
}

/** The system-prompt block. Deterministic wording — the system prompt should be byte-stable across runs while the file is unchanged. */
export function formatInstructionsBlock(instructions: IProjectInstructions): string {
	return `Project instructions from ${instructions.file} (follow these for this workspace):\n${instructions.text}`;
}
