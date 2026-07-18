/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IObservable } from '../../../base/common/observable.js';
import type { PermissionMode } from '../../agent/common/agent.js';

export const enum SessionStatus {
	Untitled = 0,
	InProgress = 1,
	NeedsInput = 2,
	Completed = 3,
	Error = 4,
}

export const enum SessionInteractivity {
	Full = 'full',
	ReadOnly = 'read-only',
	Hidden = 'hidden',
}

export interface ISessionWorkspace {
	readonly label: string;
	readonly description?: string;
	readonly branchName?: string;
}

export interface ISessionChangesSummary {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
}

/** A chat → data panel hand-off, riding a work step (#4/#7). `kind` absent
 *  means 'sql' — payloads persisted before the union existed stay valid. */
export type ISessionDataBrowse =
	| {
			readonly kind?: 'sql';
			/** The source as the model addressed it (id, label, or environment name). */
			readonly source: string;
			readonly sql: string;
	  }
	| {
			/** An agent-rendered table (render_data) or any tabular file. */
			readonly kind: 'file';
			readonly path: string;
			readonly name: string;
	  };

/** render_data's tool result ends with `[table:<absolute csv path>]` — the
 *  machine-readable tail the renderer lifts the chip payload from (and strips
 *  from the step detail). Shared here because both sides must agree. */
export const RENDERED_TABLE_MARKER = /\n\[table:(.+)\]$/;

/** One step inside a work block: a thinking stretch or a tool call. */
export interface ISessionWorkStep {
	/** 'narration': pre-tool announce text the model emitted in a WORK turn ("我来梳理一下…") — shown as a step, never as the answer bubble. */
	readonly kind: 'thinking' | 'tool' | 'narration';
	readonly label: string;
	readonly durationMs: number;
	/** Expandable detail — for tool steps, the (truncated) output. */
	readonly detail?: string;
	/** Still executing — rendered with a spinner instead of a duration chip. Live-view only; never persisted (the step closes before finalize writes). */
	readonly running?: boolean;
	/** query_data_source steps only: powers the "在数据浏览器打开" affordance. */
	readonly browse?: ISessionDataBrowse;
	/**
	 * Structured facts for replayable rendering (#14 Q3) — the renderer derives
	 * verbs/chips/rollups/status from these, never persists derived output.
	 * Absent on legacy records, which fall back to the pre-rendered `label`.
	 */
	/** Raw tool name as the agent invoked it (e.g. 'read_file'); child-loop actions carry the CHILD's real tool so read sweeps fold into rollups. */
	readonly tool?: string;
	/** The most telling argument (path / command / pattern…), first-line bounded. */
	readonly arg?: string;
	/** Result state of a closed tool step. */
	readonly outcome?: 'ok' | 'error';
	/** The step ran inside a spawned child loop — rendered with the ⑃ marker the label carries. */
	readonly via?: 'subagent';
}

/**
 * A structured reference the user attached to a message (@-mentions and pasted
 * images today; sessions and skills are future kinds). File/folder paths are
 * workspace-relative — the agent reads them through its tools. Image paths are
 * session-media-relative (`media/<sessionId>/<hash>.png`); the bytes live on
 * disk beside the transcript, never inlined here.
 */
export interface ISessionAttachment {
	readonly kind: 'file' | 'folder' | 'image' | 'skill' | 'session';
	/** file/folder: workspace-relative path; image: session-media path; skill: the skill id; session: the referenced sessionId. */
	readonly path: string;
	/** Images only: e.g. 'image/png'. */
	readonly mediaType?: string;
	/** Human-readable name for chips (session title at attach time). */
	readonly label?: string;
}

/** One section of a plan artifact — the stable anchor unit for review comments. */
export interface IPlanSection {
	/** Renderer-assigned, deterministic (`${planId}-s${index}`) — the model never sees ids. */
	readonly id: string;
	readonly kind: 'overview' | 'files' | 'approach' | 'steps' | 'risks' | 'verify';
	readonly heading: string;
	/** Markdown body, rendered with the shared markdown renderer. */
	readonly body: string;
	/** Bullet items (files / steps sections). */
	readonly items?: readonly string[];
}

/**
 * A reviewable implementation plan the model proposed via `propose_plan`. Rides
 * on a `role:'plan'` message; the message's `text` holds a markdown fallback so
 * older builds (and the next run's transcript) still see the content.
 */
export interface IPlanArtifact {
	readonly id: string;
	/** Iteration number within the session; a revision supersedes the prior version. */
	readonly version: number;
	readonly title: string;
	readonly sections: readonly IPlanSection[];
	/** Named `state` (not `status`) so a top-level echo can never collide with the fold's session-status key. */
	readonly state: 'draft' | 'approved' | 'superseded';
	/**
	 * 'plan' (default when absent): pre-execution proposal, reviewable draft,
	 * new versions supersede old. 'walkthrough': post-completion report (what
	 * was done + how to verify) — settled on arrival, never versioned away.
	 */
	readonly kind?: 'plan' | 'walkthrough';
}

/**
 * A generic interactive card the model rendered via `render_ui`. Rides on a
 * `role:'ui'` message; the message's `text` holds a markdown fallback so older
 * builds, unregistered components, and the next run's transcript still see the
 * content. `props` is the component's own payload — validated per-component
 * (uiComponents/), opaque to the envelope, and JSON-round-trippable by
 * construction (storage is bare JSON.stringify).
 */
export interface IUiArtifact {
	readonly id: string;
	/** Which registered component renders this card (e.g. 'migration_preview'). */
	readonly component: string;
	readonly title: string;
	readonly props: unknown;
}

/**
 * A user's review comment on one plan section (Google-Docs style margin note).
 * Comments belong to a plan VERSION — section ids are version-scoped, so they
 * never drift when a revision regenerates the sections.
 */
export interface IPlanComment {
	readonly id: string;
	readonly planId: string;
	readonly sectionId: string;
	readonly body: string;
	readonly resolved: boolean;
	readonly createdAt: Date;
}

export interface ISessionMessage {
	readonly id: string;
	/**
	 * 'work' messages summarize one agent run: total duration plus its steps.
	 * 'digest' messages are hidden, deterministic per-run work summaries (files
	 * read/changed) carried on the next run's transcript — not rendered.
	 */
	readonly role: 'user' | 'assistant' | 'tool' | 'work' | 'plan' | 'digest' | 'ui';
	readonly text: string;
	readonly attachments?: readonly ISessionAttachment[];
	readonly detail?: string;
	/** Total run duration; unset while the run is still in progress. */
	readonly durationMs?: number;
	readonly steps?: readonly ISessionWorkStep[];
	/** 'plan' messages carry the structured artifact; `text` is its markdown fallback. */
	readonly plan?: IPlanArtifact;
	/** 'ui' messages carry the structured card envelope; `text` is its markdown fallback. */
	readonly ui?: IUiArtifact;
	readonly feedback?: 'like' | 'dislike';
	/** When the message landed (user: send time; assistant: reply completion). */
	readonly timestamp?: Date;
}

/** The model stream dropped; the harness is retrying with backoff. */
export interface ISessionReconnect {
	readonly attempt: number;
	readonly maxAttempts: number;
}

/**
 * What the most recent request's view was made of, in chars. All rows are
 * char/4 estimates the panel labels as such — only the sibling
 * {@link ISessionContextUsage.inputTokens} (the total) is a real provider count.
 */
export interface ISessionContextBreakdown {
	readonly systemChars: number;
	readonly instructionsChars: number;
	readonly skillsChars: number;
	readonly toolsChars: number;
	readonly messagesChars: number;
	readonly compactedChars: number;
	readonly prunedChars: number;
}

/**
 * Where the meter's total came from — the UI labels each state honestly:
 * - 'real': the provider's own usage reading, produced in THIS process (no label).
 * - 'restored': a real reading persisted by a previous run and rehydrated —
 *   a true bill, just possibly stale (model/window may have changed since).
 *   Labeled "(last run)".
 * - 'estimate': the char/4 fallback — no real reading exists yet (a run's
 *   FIRST context_breakdown fires before the model has replied). Labeled
 *   "(estimated)", exactly like a wholly-absent contextUsage.
 */
export type SessionContextTotalSource = 'real' | 'restored' | 'estimate';

/** Real token count from the most recent request — ground truth for the context-window meter. */
export interface ISessionContextUsage {
	readonly inputTokens: number;
	readonly totalSource: SessionContextTotalSource;
	/** Absent for models/turns that never emitted a context_breakdown event (e.g. a text-only run with no workspace). */
	readonly breakdown?: ISessionContextBreakdown;
}

/** char/4 estimate over a session's persisted text — the fallback used whenever no real usage reading exists yet for this process. Centralized so the ring and the provider's interim (pre-first-usage) reading never drift apart. */
export function estimateSessionTokens(messages: readonly { readonly text: string }[]): number {
	const chars = messages.reduce((sum, message) => sum + message.text.length, 0);
	return Math.ceil(chars / 4);
}

/** A tool call paused on the user's allow / deny. */
export interface ISessionPendingApproval {
	readonly requestId: string;
	readonly toolName: string;
	/** One-line summary of what the tool wants to do (command, file path…). */
	readonly detail: string;
	/** Present iff this call can be "always allowed" this session — the button label (e.g. `mvn *`). */
	readonly alwaysAllow?: string;
	/** True when the grant can also be persisted to the project (bash: only). */
	readonly alwaysAllowProject?: boolean;
	/** `always` records the pattern so future matching calls skip the prompt;
	 *  scope 'project' persists it beyond the process (personal, per-machine). */
	respond(approved: boolean, always?: boolean, scope?: 'session' | 'project'): void;
}

export interface ISession {
	readonly sessionId: string;
	readonly providerId: string;
	readonly sessionType: string;
	readonly icon: string;
	readonly createdAt: Date;
	readonly projectId: string | undefined;
	readonly workspace: IObservable<ISessionWorkspace | undefined>;
	readonly title: IObservable<string>;
	readonly updatedAt: IObservable<Date>;
	readonly status: IObservable<SessionStatus>;
	readonly description: IObservable<string | undefined>;
	readonly changesSummary: IObservable<ISessionChangesSummary | undefined>;
	readonly isArchived: IObservable<boolean>;
	readonly isRead: IObservable<boolean>;
	readonly isPinned: IObservable<boolean>;
	readonly messages: IObservable<readonly ISessionMessage[]>;
	/** Review comments on plan artifacts, upserted by id (resolve = same id, resolved:true). */
	readonly planComments: IObservable<readonly IPlanComment[]>;
	readonly interactivity: IObservable<SessionInteractivity>;
	readonly pendingApproval: IObservable<ISessionPendingApproval | undefined>;
	readonly reconnect: IObservable<ISessionReconnect | undefined>;
	readonly permissionMode: IObservable<PermissionMode>;
	/** Undefined until the first real usage reading arrives; the UI falls back to an estimate until then. */
	readonly contextUsage: IObservable<ISessionContextUsage | undefined>;
}

export interface IActiveSession extends ISession {
	readonly isCreated: IObservable<boolean>;
	readonly sticky: IObservable<boolean>;
}
