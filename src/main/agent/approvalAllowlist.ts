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
 *   - `run_on_server` and `upload_to_server` (SSH, incl. prod) are EXCLUDED:
 *     their ONLY guard is the approval prompt itself, so letting them be
 *     always-allowed would silently bypass prod write protection. They are
 *     never offered and never match.
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

/**
 * A bash call that opts out of the write sandbox. It escalates: approval fires
 * in EVERY permission mode (full included — the sandbox is the last guard
 * there), and a normal `bash:` grant never covers it.
 */
export function isSandboxEscape(toolName: string, input: unknown): boolean {
	return toolName === 'bash' && typeof input === 'object' && input !== null && (input as { disable_sandbox?: unknown }).disable_sandbox === true;
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
		// Sandbox-escape grants live in their own namespace: always-allowing
		// "mvn *（沙箱外）" is a bigger decision than "mvn *", never conflated.
		if (isSandboxEscape(toolName, input)) {
			return { patterns: tokens.map(token => `bash-nosandbox:${token}`), display: tokens.map(token => `${token} *（沙箱外）`).join(', ') };
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
	// A sandbox-escape call matches ONLY nosandbox grants; a sandboxed call is
	// covered by either (the nosandbox grant is the superset privilege).
	const tokens = bashLeadingTokens(input);
	if (tokens.length === 0) {
		return false;
	}
	if (isSandboxEscape(toolName, input)) {
		return tokens.every(token => patterns.has(`bash-nosandbox:${token}`));
	}
	return tokens.every(token => patterns.has(`bash:${token}`) || patterns.has(`bash-nosandbox:${token}`));
}
