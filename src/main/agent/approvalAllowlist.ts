/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-level "always allow": lets a user retire the repeat-approval tax for
 * a class of tool calls WITHOUT persisting anything. The gate consults a
 * per-session pattern set before it would raise an approval prompt; a hit runs
 * the call unattended.
 *
 * SAFETY — the allowlist is deliberately narrow:
 *
 *   - Only bash / write_file / edit_file are ever always-allowable. bash writes
 *     are already boxed by the seatbelt sandbox and file writes by the code-root
 *     boundary, so an always-allow here cannot escape those inner guards.
 *   - `run_on_server` (SSH, incl. prod) is EXCLUDED: its ONLY guard is the
 *     approval prompt itself, so letting it be always-allowed would silently
 *     bypass prod write protection. It is never offered and never matches.
 *
 * Matching mirrors Claude Code's rules: word-boundary leading-token prefixes
 * (`mvn *` matches `mvn test`, never `mvnd`), compound commands split into
 * sub-commands, and DENY-FIRST — every sub-command must be allowlisted or the
 * whole line falls back to a prompt.
 */

/** The only tools a session may ever "always allow". Everything else always prompts. */
const ALWAYS_ALLOWABLE_TOOLS: ReadonlySet<string> = new Set(['bash', 'write_file', 'edit_file']);

/** A single "all file edits this session" pattern — write_file and edit_file both match it. */
const EDIT_PATTERN = 'edit:*';

/** Shell operators that separate independent sub-commands. */
const SUBCOMMAND_SEPARATORS = /\s*(?:&&|\|\||[|;&\n])\s*/;

export interface IAllowlistGrant {
	/** Opaque pattern strings added to the session set (e.g. `bash:git`, `edit:*`). */
	readonly patterns: readonly string[];
	/** Human label for the "always allow …" button (e.g. `mvn *`, `所有文件修改`). */
	readonly display: string;
}

function commandOf(input: unknown): string | undefined {
	if (typeof input === 'object' && input !== null) {
		const value = (input as { command?: unknown }).command;
		if (typeof value === 'string' && value.trim() !== '') {
			return value;
		}
	}
	return undefined;
}

/** Leading token of every sub-command in a shell line, deduped, order-preserving. */
function bashLeadingTokens(input: unknown): string[] {
	const command = commandOf(input);
	if (command === undefined) {
		return [];
	}
	const tokens: string[] = [];
	for (const part of command.split(SUBCOMMAND_SEPARATORS)) {
		const token = part.trim().split(/\s+/)[0];
		if (token !== undefined && token !== '' && !tokens.includes(token)) {
			tokens.push(token);
		}
	}
	return tokens;
}

/** Whether a tool COULD be always-allowed (drives whether the third button is offered). */
export function isAlwaysAllowable(toolName: string): boolean {
	return ALWAYS_ALLOWABLE_TOOLS.has(toolName);
}

/**
 * The grant a given request would add if the user picks "always allow", or
 * undefined when the tool is not always-allowable (run_on_server, unknown) or
 * the input yields no usable pattern (e.g. an empty bash command).
 */
export function deriveGrant(toolName: string, input: unknown): IAllowlistGrant | undefined {
	if (toolName === 'write_file' || toolName === 'edit_file') {
		return { patterns: [EDIT_PATTERN], display: '所有文件修改' };
	}
	if (toolName === 'bash') {
		const tokens = bashLeadingTokens(input);
		if (tokens.length === 0) {
			return undefined;
		}
		return { patterns: tokens.map(token => `bash:${token}`), display: tokens.map(token => `${token} *`).join(', ') };
	}
	return undefined;
}

/**
 * Whether this call is already covered by the session's allowlist — checked at
 * the gate BEFORE any prompt. Deny-first for compound bash lines; run_on_server
 * and any non-always-allowable tool can never match.
 */
export function matchesAllowlist(toolName: string, input: unknown, patterns: ReadonlySet<string>): boolean {
	if (!isAlwaysAllowable(toolName)) {
		return false;
	}
	if (toolName === 'write_file' || toolName === 'edit_file') {
		return patterns.has(EDIT_PATTERN);
	}
	// bash: every sub-command's leading token must be allowlisted (deny-first).
	const tokens = bashLeadingTokens(input);
	return tokens.length > 0 && tokens.every(token => patterns.has(`bash:${token}`));
}
