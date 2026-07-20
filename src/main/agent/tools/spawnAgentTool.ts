/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { runAgentLoop } from '../agentLoop.js';
import { allowAllPermissionGate, defineTool } from '../agentTools.js';
import type { IAgentTool, IModelClient } from '../agentTypes.js';
import type { ILanguageServerManager } from '../lsp/languageServerManager.js';
import { createWorkspaceTools } from './index.js';
import { asRecord, invalid, requireString, valid } from './workspace.js';

/**
 * spawn_agent — delegate a read-only exploration to an in-process sub-agent.
 *
 * NOT a subprocess: the child is a recursive `runAgentLoop` call in this same
 * (Electron main) process — no shell, no PTY, so the mechanism itself is
 * platform-neutral (Windows/Linux/macOS); the only platform surface is the
 * workspace tools it shares with the parent.
 *
 * Isolation contract (modeled on Claude Code's AgentTool, verified against the
 * 2.1.88 source): the child starts from ONLY the task text — no parent
 * conversation, no AGENTS.md, thinking implicitly off (the child client is the
 * parent's, but the child transcript never enables it). Its final assistant
 * text IS the tool result; the parent keeps conclusions, not file dumps.
 *
 * Anti-recursion is structural, not prompted: the child's tool set is the four
 * read-only file tools — spawn_agent, bash, writes, and the meta-tools are
 * simply absent (CC: ALL_AGENT_DISALLOWED_TOOLS, "Blocked to prevent recursion").
 */

/** The child's whole tool surface. Meta-tools (update_plan etc.) are excluded: a 24-turn explorer doesn't need a checklist. read_symbol rides in only when a language-server manager is threaded through (see createWorkspaceTools). */
const CHILD_TOOL_NAMES: ReadonlySet<string> = new Set(['read_file', 'list_dir', 'glob', 'grep', 'read_symbol']);

/** A quarter of the parent's budget — an explorer that needs more should have been given a narrower task. */
const CHILD_MAX_TURNS = 24;

function childSystemPrompt(roots: readonly string[]): string {
	const lines = ["You are a read-only exploration sub-agent working inside the user's project.", `Working directory: ${roots[0]}`];
	if (roots.length > 1) {
		lines.push(`Additional code roots (address files in these with ABSOLUTE paths): ${roots.slice(1).join(', ')}.`);
	}
	lines.push(
		'Tools: read_file, list_dir, glob, grep. You cannot change files, run commands, or delegate further.',
		'Your FINAL message is returned verbatim to the calling agent as a tool result — it is not shown to a human. Make it conclusions only: what was found, each claim backed by file:line evidence. No preamble, no narration of your process, no questions back.',
		'Batch independent reads and searches into a single turn. Read WIDE — omit read_file `limit` or take a generous window rather than 30-line slices, and pass grep a `context` window instead of following a grep with a separate read_file. Stop as soon as the task is answered — do not keep exploring past it.',
		roots.length > 1
			? 'Relative paths resolve against the working directory; use absolute paths for the other code roots. You cannot access files outside these roots.'
			: 'All paths are relative to the working directory; you cannot access files outside it.',
	);
	return lines.join('\n');
}

/**
 * Progress channel — agentIpc wires this to BOTH the run logger (jsonl) and the
 * renderer ('agent:event'), so the work panel narrates the child live. The
 * events are part of IAgentEvent but are never YIELDED by a loop; they ride
 * this side channel because the parent loop is blocked awaiting the tool.
 */
export type SubagentRecord = (
	event:
		| { readonly type: 'subagent_start'; readonly agentId: string; readonly task: string }
		| { readonly type: 'subagent_tool'; readonly agentId: string; readonly name: string; readonly summary: string; readonly turn: number }
		| { readonly type: 'subagent_progress'; readonly agentId: string; readonly phase: 'thinking' | 'replying'; readonly chars: number }
		| { readonly type: 'subagent_end'; readonly agentId: string; readonly reason: string; readonly turns: number; readonly toolCalls: number; readonly tokens: number; readonly outputChars: number },
) => void;

/** Repeat progress at most this often — each delta would otherwise spam the log/IPC. A phase ENTRY always reports immediately, so even the first chunk of a long report flips the frozen tool row to "writing". */
const PROGRESS_REPEAT_MS = 2000;

/** One line for the work panel: tool + its one telling argument, bounded. */
function describeChildCall(name: string, input: unknown): string {
	const record = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
	const arg = [record['path'], record['pattern']].find(value => typeof value === 'string' && value !== '');
	const text = typeof arg === 'string' ? `${name} ${arg}` : name;
	return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export interface ISpawnAgentDeps {
	readonly roots: readonly string[];
	readonly modelClient: IModelClient;
	readonly record?: SubagentRecord;
	/** Shared with the parent so a child's read_symbol reuses the same running servers. */
	readonly languageServers?: ILanguageServerManager;
}

export function createSpawnAgentTool(deps: ISpawnAgentDeps): IAgentTool {
	const childTools = createWorkspaceTools(deps.roots, deps.languageServers ? { languageServers: deps.languageServers } : {}).filter(tool => CHILD_TOOL_NAMES.has(tool.name));
	const system = childSystemPrompt(deps.roots);

	return defineTool({
		name: 'spawn_agent',
		description:
			'Delegate a read-only exploration to a sub-agent with its OWN context and return only its conclusions. ' +
			'The ONE criterion is context economy — will you need the files\' contents again after the sweep? If not ' +
			'(audits, find-all-usages, tracing a value across modules, structure surveys): delegate — you keep the summary, not the file dumps. ' +
			'When NOT to use it: a known file path → read_file directly; a specific class/function/symbol → grep or glob directly; ' +
			'anything scoped to 2-3 files → read them yourself; and never re-delegate work a sub-agent already covered. ' +
			'The sub-agent has a hard budget of ~24 turns — a sweep too big for that (e.g. hundreds of files) MUST be SHARDED: ' +
			'several spawn_agent calls, each scoped to one module/directory, instead of one call for everything. ' +
			'Size each shard to finish comfortably within ~15 turns; when unsure, cut SMALLER — a shard that runs out of budget ' +
			'reports PARTIAL and forces a serial remainder round, doubling wall-clock time. ' +
			'Independent sweeps MUST be issued in a SINGLE message with multiple spawn_agent calls — they run concurrently. ' +
			'Write the task self-contained (the sub-agent sees nothing of this conversation), state the expected output shape ' +
			'(e.g. "list every X with file:line"), and say how thorough to be.',
		inputSchema: {
			type: 'object',
			properties: {
				task: { type: 'string', description: 'Self-contained task, including the expected output shape and thoroughness.' },
				scope: { type: 'string', description: 'Optional starting point — a directory or file to focus on.' },
			},
			required: ['task'],
			additionalProperties: false,
		},
		isReadOnly: () => true,
		// The P2 parallelism seat, filled (#15): children are read-only loops on
		// separate API streams — a 5-probe test saw no throttling at 5 concurrent
		// k3 requests, and the runner caps each batch (maxToolConcurrency).
		isConcurrencySafe: () => true,
		validateInput: input => {
			const record = asRecord(input);
			if (!record) {
				return invalid('input must be an object');
			}
			try {
				requireString(record, 'task');
			} catch (error) {
				return invalid(error instanceof Error ? error.message : String(error));
			}
			if (record.scope !== undefined && typeof record.scope !== 'string') {
				return invalid('scope must be a string');
			}
			return valid(record);
		},
		call: async (input, context) => {
			const { task, scope } = input as { task: string; scope?: string };
			const prompt = scope ? `${task}\n\nFocus on: ${scope}` : task;
			// The spawning tool_use id doubles as the agent id — unique per call and
			// lets the UI tie the child's narration to its spawn card.
			const agentId = context.toolUseId;
			deps.record?.({ type: 'subagent_start', agentId, task: task.slice(0, 200) });

			// The child is a plain nested loop: same abort signal (user stop stops
			// everything), reply verifier off (the parent consumes the conclusion —
			// no one to re-ask), compaction off (24 turns never needs it).
			const loop = runAgentLoop([{ role: 'user', content: [{ type: 'text', text: prompt }] }], {
				system,
				tools: childTools,
				modelClient: deps.modelClient,
				permissionGate: allowAllPermissionGate,
				signal: context.signal,
				maxTurns: CHILD_MAX_TURNS,
				disableReplyVerifier: true,
			});

			let conclusion = '';
			let digestText: string | undefined;
			let toolCalls = 0;
			let tokens = 0;
			let childTurn = 0;
			// Streaming liveness (#19 缺陷 1): a child's last turn can be one multi-
			// minute model request with zero tool events — indistinguishable from a
			// hang. Fold its deltas into subagent_progress: report on every phase
			// entry, then at most every PROGRESS_REPEAT_MS while the phase streams.
			let progressPhase: 'thinking' | 'replying' | undefined;
			let progressChars = 0;
			let progressReportedAt = 0;
			const streamProgress = (phase: 'thinking' | 'replying', chunk: string): void => {
				if (phase !== progressPhase) {
					progressPhase = phase;
					progressChars = 0;
					progressReportedAt = 0;
				}
				progressChars += chunk.length;
				const now = Date.now();
				if (progressReportedAt === 0 || now - progressReportedAt >= PROGRESS_REPEAT_MS) {
					progressReportedAt = now;
					deps.record?.({ type: 'subagent_progress', agentId, phase, chars: progressChars });
				}
			};
			let step = await loop.next();
			while (!step.done) {
				const event = step.value;
				if (event.type === 'assistant_message') {
					conclusion = event.text; // the LAST assistant text wins — same as CC's finalizeAgentTool
				} else if (event.type === 'turn_start') {
					childTurn = event.turn;
					progressPhase = undefined; // next delta re-announces its phase
				} else if (event.type === 'thinking_delta') {
					streamProgress('thinking', event.text);
				} else if (event.type === 'assistant_delta') {
					streamProgress('replying', event.text);
				} else if (event.type === 'tool_use') {
					toolCalls += 1;
					progressPhase = undefined; // the tool row takes the live label back
					deps.record?.({ type: 'subagent_tool', agentId, name: event.name, summary: describeChildCall(event.name, event.input), turn: childTurn });
				} else if (event.type === 'usage') {
					tokens += event.inputTokens + (event.outputTokens ?? 0) + (event.cacheReadTokens ?? 0) + (event.cacheWriteTokens ?? 0);
				} else if (event.type === 'work_digest') {
					digestText = event.text; // parsed back into the PARENT's digest by the loop (see agentLoop)
				}
				step = await loop.next();
			}
			const terminal = step.value;
			deps.record?.({ type: 'subagent_end', agentId, reason: terminal.reason, turns: terminal.turns, toolCalls, tokens, outputChars: conclusion.length });

			if (terminal.reason === 'aborted') {
				return { content: 'Sub-agent aborted.', isError: true };
			}
			if (conclusion.trim() === '') {
				return { content: `Sub-agent returned no conclusions (reason: ${terminal.reason}).`, isError: true };
			}
			// Usage trailer (CC-style) gives the parent model a feel for delegation
			// cost; the digest block is machine-read by the parent loop AND tells the
			// parent model which files were already covered.
			const trailer = `<subagent-usage>turns=${terminal.turns} tool_calls=${toolCalls} tokens=${tokens}</subagent-usage>`;
			return { content: [conclusion.trim(), trailer, ...(digestText ? [digestText] : [])].join('\n\n') };
		},
	});
}
