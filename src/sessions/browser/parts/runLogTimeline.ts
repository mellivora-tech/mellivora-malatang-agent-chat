/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IRunLogEvent } from '../../services/logs/common/logs.js';

/**
 * Pure derivation from a run's raw log lines to the timeline render model —
 * the workRender.ts discipline: no DOM, no clocks, no i18n, so replaying a
 * stored run is unit-testable and renders identically every time. Labels are
 * composed by the VIEW from these typed fields; this module only classifies.
 *
 * Input is the loose {@link IRunLogEvent} transport shape on purpose: log lines
 * may come from older or newer builds, and an unrecognized type must degrade to
 * a generic row — a viewer that throws on its own logs is worse than no viewer.
 */

export interface IRunTimelineTool {
	readonly name: string;
	/** Pretty-printed input JSON, when the run was logged in full mode. */
	readonly input?: string;
	readonly output?: string;
	readonly ok?: boolean;
	readonly durationMs?: number;
	readonly outputBytes?: number;
}

export type RunTimelineItemKind = 'turn' | 'stretch' | 'tool' | 'usage' | 'subagent' | 'error' | 'other';

export interface IRunTimelineItem {
	readonly kind: RunTimelineItemKind;
	/** Replay step position — the index of the source event in the run's stream. */
	readonly index: number;
	readonly ts: string;
	readonly turn: number;
	/** Raw event type — the generic-row label and the detail pane's heading. */
	readonly type: string;
	readonly severity?: 'error';
	// turn
	readonly ttftMs?: number;
	// stretch
	readonly stretchKind?: 'thinking' | 'text';
	readonly durationMs?: number;
	readonly chars?: number;
	readonly text?: string;
	// tool (result fields filled in when the paired tool_result arrives)
	readonly tool?: IRunTimelineTool;
	// usage
	readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number };
	// subagent / error / other
	readonly agentId?: string;
	readonly message?: string;
	/** Raw event JSON for the detail pane — every row is inspectable. */
	readonly raw: string;
}

export interface IRunTimelineHeader {
	readonly runId?: string;
	readonly sessionId?: string;
	readonly model?: string;
	readonly permissionMode?: string;
	readonly build?: string;
	readonly prompt?: string;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly reason?: string;
	readonly durationMs?: number;
	readonly turns?: number;
	readonly totalOutputTokens?: number;
	/** Largest true prompt (input + cache read + cache write) any turn sent. */
	readonly peakPromptTokens?: number;
	readonly errorCount: number;
	/** True when the stream holds only run boundaries — an errors-mode run with no failures. */
	readonly boundariesOnly: boolean;
}

export interface IRunTimeline {
	readonly header: IRunTimelineHeader;
	readonly items: readonly IRunTimelineItem[];
}

function num(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function detailOf(event: IRunLogEvent): Record<string, unknown> {
	const detail = event['detail'];
	return typeof detail === 'object' && detail !== null ? (detail as Record<string, unknown>) : {};
}

function pretty(value: unknown): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value, undefined, 2);
	} catch {
		return String(value);
	}
}

export function buildRunTimeline(events: readonly IRunLogEvent[]): IRunTimeline {
	const items: IRunTimelineItem[] = [];
	// tool_use rows are created open and completed in place when their
	// tool_result lands — pairing by toolUseId, same as the live loop.
	const openTools = new Map<string, number>();
	let header: IRunTimelineHeader = { errorCount: 0, boundariesOnly: true };
	let turn = 0;
	let lastTurnItem: number | undefined;
	let errorCount = 0;
	let totalOutputTokens: number | undefined;
	let peakPromptTokens: number | undefined;
	let sawNonBoundary = false;

	for (let index = 0; index < events.length; index++) {
		const event = events[index]!;
		const ts = event.ts;
		const raw = pretty(event) ?? '';
		const detail = detailOf(event);
		switch (event.type) {
			case 'run_start': {
				const runId = str(event['runId']);
				const sessionId = str(event['sessionId']);
				const model = str(event['model']);
				const permissionMode = str(event['mode']);
				const build = str(event['build']);
				const prompt = str(detail['prompt']);
				header = {
					...header,
					...(runId !== undefined ? { runId } : {}),
					...(sessionId !== undefined ? { sessionId } : {}),
					...(model !== undefined ? { model } : {}),
					...(permissionMode !== undefined ? { permissionMode } : {}),
					...(build !== undefined ? { build } : {}),
					...(prompt !== undefined ? { prompt } : {}),
					startedAt: ts,
				};
				break;
			}
			case 'run_end': {
				const reason = str(event['reason']);
				const durationMs = num(event['durationMs']);
				const turns = num(event['turns']);
				header = {
					...header,
					endedAt: ts,
					...(reason !== undefined ? { reason } : {}),
					...(durationMs !== undefined ? { durationMs } : {}),
					...(turns !== undefined ? { turns } : {}),
				};
				break;
			}
			case 'turn_start':
				sawNonBoundary = true;
				turn = num(event['turn']) ?? turn + 1;
				lastTurnItem = items.length;
				items.push({ kind: 'turn', index, ts, turn, type: event.type, raw });
				break;
			case 'ttft': {
				sawNonBoundary = true;
				// Fold into the open turn row instead of its own line.
				const ttftMs = num(event['ttftMs']);
				if (lastTurnItem !== undefined && items[lastTurnItem] !== undefined && ttftMs !== undefined) {
					items[lastTurnItem] = { ...items[lastTurnItem]!, ttftMs };
				}
				break;
			}
			case 'reasoning_stretch': {
				sawNonBoundary = true;
				const stretchKind = event['kind'] === 'thinking' ? 'thinking' : 'text';
				const durationMs = num(event['durationMs']);
				const chars = num(event['chars']);
				const text = str(detail['text']);
				items.push({
					kind: 'stretch',
					index,
					ts,
					turn: num(event['turn']) ?? turn,
					type: event.type,
					stretchKind,
					...(durationMs !== undefined ? { durationMs } : {}),
					...(chars !== undefined ? { chars } : {}),
					...(text !== undefined ? { text } : {}),
					raw,
				});
				break;
			}
			case 'tool_use': {
				sawNonBoundary = true;
				const name = str(event['name']) ?? '?';
				const input = pretty(detail['input']);
				items.push({ kind: 'tool', index, ts, turn, type: event.type, tool: { name, ...(input !== undefined ? { input } : {}) }, raw });
				const toolUseId = str(event['toolUseId']);
				if (toolUseId !== undefined) {
					openTools.set(toolUseId, items.length - 1);
				}
				break;
			}
			case 'tool_result': {
				sawNonBoundary = true;
				const ok = event['ok'] !== false;
				if (!ok) {
					errorCount++;
				}
				const toolUseId = str(event['toolUseId']);
				const open = toolUseId !== undefined ? openTools.get(toolUseId) : undefined;
				const durationMs = num(event['durationMs']);
				const outputBytes = num(event['outputBytes']);
				const output = str(detail['output']);
				const result = {
					ok,
					...(durationMs !== undefined ? { durationMs } : {}),
					...(outputBytes !== undefined ? { outputBytes } : {}),
					...(output !== undefined ? { output } : {}),
				};
				if (open !== undefined && items[open]?.kind === 'tool') {
					const item = items[open]!;
					items[open] = { ...item, ...(ok ? {} : { severity: 'error' }), tool: { ...item.tool!, ...result }, raw: `${item.raw}\n${raw}` };
					if (toolUseId !== undefined) {
						openTools.delete(toolUseId);
					}
				} else {
					// Errors-mode logs keep failing results without their tool_use —
					// render them standalone rather than dropping the failure.
					items.push({ kind: 'tool', index, ts, turn, type: event.type, ...(ok ? {} : { severity: 'error' as const }), tool: { name: str(event['name']) ?? '?', ...result }, raw });
				}
				break;
			}
			case 'usage': {
				sawNonBoundary = true;
				const inputTokens = num(event['inputTokens']);
				const outputTokens = num(event['outputTokens']);
				const cacheReadTokens = num(event['cacheReadTokens']);
				const cacheWriteTokens = num(event['cacheWriteTokens']);
				const usage = {
					...(inputTokens !== undefined ? { inputTokens } : {}),
					...(outputTokens !== undefined ? { outputTokens } : {}),
					...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
					...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
				};
				totalOutputTokens = (totalOutputTokens ?? 0) + (usage.outputTokens ?? 0);
				const prompt = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
				peakPromptTokens = Math.max(peakPromptTokens ?? 0, prompt);
				items.push({ kind: 'usage', index, ts, turn: num(event['turn']) ?? turn, type: event.type, usage, raw });
				break;
			}
			case 'subagent_start':
			case 'subagent_tool':
			case 'subagent_progress':
			case 'subagent_end': {
				sawNonBoundary = true;
				const message = str(detail['task']) ?? str(detail['summary']) ?? str(event['name']) ?? str(event['reason']);
				const agentId = str(event['agentId']);
				items.push({
					kind: 'subagent',
					index,
					ts,
					turn,
					type: event.type,
					...(agentId !== undefined ? { agentId } : {}),
					...(message !== undefined ? { message } : {}),
					raw,
				});
				break;
			}
			case 'error':
			case 'renderer_error':
			case 'main_error': {
				sawNonBoundary = true;
				errorCount++;
				const message = str(detail['message']);
				items.push({ kind: 'error', index, ts, turn, type: event.type, severity: 'error', ...(message !== undefined ? { message } : {}), raw });
				break;
			}
			default: {
				// Everything else — compactions, nudges, retries, hooks, unknown
				// future types — is a generic row labeled by its raw type.
				sawNonBoundary = true;
				const failed =
					event.type === 'stream_retry' ||
					event.type === 'loop_guard' ||
					(event.type === 'compaction' && event['outcome'] === 'error') ||
					(event.type === 'reply_verifier' && event['verdict'] !== 'pass');
				if (failed) {
					errorCount++;
				}
				items.push({ kind: 'other', index, ts, turn, type: event.type, ...(failed ? { severity: 'error' as const } : {}), raw });
				break;
			}
		}
	}

	return {
		header: {
			...header,
			errorCount,
			boundariesOnly: !sawNonBoundary,
			...(totalOutputTokens !== undefined ? { totalOutputTokens } : {}),
			...(peakPromptTokens !== undefined ? { peakPromptTokens } : {}),
		},
		items,
	};
}
