/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../common/i18n/i18n.js';
import { reportFailure } from '../../common/diagnostics.js';
import { clearNode } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import type { ILogsBridge, IRunSummary } from '../../services/logs/common/logs.js';
import type { ISessionsService } from '../../services/sessions/browser/sessionsService.js';
import { Dropdown } from './dropdown.js';
import { buildRunTimeline, type IRunTimeline, type IRunTimelineItem } from './runLogTimeline.js';

export interface IRunLogViewOptions {
	readonly sessionsService?: ISessionsService;
	readonly logs?: ILogsBridge;
}

/**
 * The 运行日志 tab: pick a run, see its full event timeline, and REPLAY it —
 * a step index over the (pure, prebuilt) timeline model; stepping just moves
 * the dimming boundary and the detail pane, nothing is re-derived. Runs logged
 * in errors-only mode show boundaries plus failures with an explanatory notice.
 */
export class RunLogView extends Disposable {
	private readonly root: HTMLElement;
	private readonly toolbar: HTMLElement;
	private readonly notice: HTMLElement;
	private readonly headerBlock: HTMLElement;
	private readonly playback: HTMLElement;
	private readonly list: HTMLElement;
	private readonly detail: HTMLElement;

	private runs: readonly IRunSummary[] = [];
	private selectedRunId: string | undefined;
	private timeline: IRunTimeline | undefined;
	private truncated = false;
	private step = 0;
	private dropdown: Dropdown | undefined;
	private slider: HTMLInputElement | undefined;
	private positionLabel: HTMLElement | undefined;
	private rows: HTMLElement[] = [];
	private loadToken = 0;
	private disposed = false;

	constructor(
		container: HTMLElement,
		private readonly options: IRunLogViewOptions,
	) {
		super();
		this._register(
			toDisposable(() => {
				this.disposed = true;
				this.dropdown?.dispose();
			}),
		);
		this.root = container.appendChild(document.createElement('div'));
		this.root.className = 'runlog-view';

		this.toolbar = this.root.appendChild(document.createElement('div'));
		this.toolbar.className = 'runlog-toolbar';
		this.notice = this.root.appendChild(document.createElement('div'));
		this.notice.className = 'runlog-notice';
		this.notice.hidden = true;
		this.headerBlock = this.root.appendChild(document.createElement('div'));
		this.headerBlock.className = 'runlog-header';
		this.headerBlock.hidden = true;
		this.playback = this.root.appendChild(document.createElement('div'));
		this.playback.className = 'runlog-playback';
		this.playback.hidden = true;
		this.list = this.root.appendChild(document.createElement('div'));
		this.list.className = 'runlog-list';
		this.detail = this.root.appendChild(document.createElement('div'));
		this.detail.className = 'runlog-detail';
		this.detail.hidden = true;

		// A finished run is the natural moment to refresh — but there is no push
		// channel, so re-list whenever the active session changes (artifacts-tab
		// posture) and on the manual refresh button.
		const active = this.options.sessionsService?.activeSession;
		if (active) {
			this._register(active.subscribe(() => void this.refreshRuns()));
		}
		void this.refreshRuns();
	}

	private async refreshRuns(): Promise<void> {
		const bridge = this.options.logs;
		if (!bridge) {
			this.renderToolbar();
			this.renderTimeline();
			return;
		}
		const token = ++this.loadToken;
		let runs: readonly IRunSummary[] = [];
		try {
			runs = await bridge.listRuns();
		} catch (error) {
			reportFailure('runlog.listRuns', error);
		}
		if (this.disposed || token !== this.loadToken) {
			return;
		}
		// Active session's runs first, then the rest — both newest-first.
		const sessionId = this.options.sessionsService?.activeSession.get()?.sessionId;
		this.runs = sessionId === undefined ? runs : [...runs.filter(run => run.sessionId === sessionId), ...runs.filter(run => run.sessionId !== sessionId)];
		if (this.selectedRunId === undefined || !this.runs.some(run => run.runId === this.selectedRunId)) {
			this.selectedRunId = this.runs[0]?.runId;
		}
		this.renderToolbar();
		await this.loadRun();
	}

	private async loadRun(): Promise<void> {
		const bridge = this.options.logs;
		const runId = this.selectedRunId;
		if (!bridge || runId === undefined) {
			this.timeline = undefined;
			this.renderTimeline();
			return;
		}
		const token = ++this.loadToken;
		try {
			const page = await bridge.readRun(runId);
			if (this.disposed || token !== this.loadToken) {
				return;
			}
			this.timeline = buildRunTimeline(page.events);
			this.truncated = page.truncated;
			this.step = Math.max(0, this.timeline.items.length - 1);
		} catch (error) {
			reportFailure('runlog.readRun', error);
			if (this.disposed || token !== this.loadToken) {
				return;
			}
			this.timeline = undefined;
		}
		this.renderTimeline();
	}

	private renderToolbar(): void {
		clearNode(this.toolbar);
		this.dropdown?.dispose();
		this.dropdown = undefined;

		if (this.runs.length > 0) {
			const items = this.runs.map(run => ({ value: run.runId, label: this.runLabel(run) }));
			this.dropdown = new Dropdown({
				items,
				value: this.selectedRunId ?? '',
				onChange: value => {
					this.selectedRunId = value;
					void this.loadRun();
				},
			});
			this.dropdown.element.classList.add('runlog-run-picker');
			this.dropdown.element.title = localize('runlog.pickRun');
			this.toolbar.appendChild(this.dropdown.element);
		}

		const refresh = this.toolbar.appendChild(document.createElement('button'));
		refresh.type = 'button';
		refresh.className = 'runlog-refresh';
		refresh.title = localize('runlog.refresh');
		refresh.setAttribute('aria-label', localize('runlog.refresh'));
		const icon = refresh.appendChild(document.createElement('span'));
		icon.className = 'codicon codicon-refresh';
		icon.setAttribute('aria-hidden', 'true');
		refresh.addEventListener('click', () => void this.refreshRuns());
	}

	private runLabel(run: IRunSummary): string {
		const time = new Date(run.startedAt).toLocaleString();
		const parts = [time];
		if (run.model) {
			parts.push(run.model);
		}
		if (run.loggingMode === 'errors') {
			parts.push(localize('runlog.errorsOnlyTag'));
		}
		return parts.join(' · ');
	}

	private renderTimeline(): void {
		clearNode(this.list);
		clearNode(this.headerBlock);
		clearNode(this.detail);
		this.detail.hidden = true;
		this.rows = [];
		this.notice.hidden = true;

		const timeline = this.timeline;
		if (!timeline || this.runs.length === 0) {
			this.headerBlock.hidden = true;
			this.playback.hidden = true;
			const empty = this.list.appendChild(document.createElement('div'));
			empty.className = 'runlog-empty';
			empty.textContent = localize('runlog.empty');
			return;
		}

		const noticeText = timeline.header.boundariesOnly
			? localize('runlog.errorsOnlyNotice')
			: this.truncated
				? localize('runlog.truncated', String(timeline.items.length))
				: undefined;
		if (noticeText !== undefined) {
			this.notice.textContent = noticeText;
			this.notice.hidden = false;
		}

		this.renderHeader();
		this.renderPlayback();
		for (let i = 0; i < timeline.items.length; i++) {
			this.rows.push(this.list.appendChild(this.renderRow(timeline.items[i]!, i)));
		}
		this.applyStep();
	}

	private renderHeader(): void {
		const header = this.timeline?.header;
		if (!header) {
			this.headerBlock.hidden = true;
			return;
		}
		this.headerBlock.hidden = false;

		const meta = this.headerBlock.appendChild(document.createElement('div'));
		meta.className = 'runlog-header-meta';
		const parts: string[] = [];
		if (header.model) {
			parts.push(header.model);
		}
		if (header.permissionMode) {
			parts.push(header.permissionMode);
		}
		if (header.build) {
			parts.push(header.build);
		}
		if (header.durationMs !== undefined) {
			parts.push(formatDuration(header.durationMs));
		}
		if (header.reason) {
			parts.push(header.reason);
		}
		if (header.totalOutputTokens !== undefined || header.peakPromptTokens !== undefined) {
			parts.push(localize('runlog.header.tokens', String(header.totalOutputTokens ?? 0), String(header.peakPromptTokens ?? 0)));
		}
		if (header.errorCount > 0) {
			parts.push(localize('runlog.header.errors', String(header.errorCount)));
		}
		meta.textContent = parts.join(' · ');
		if (header.errorCount > 0) {
			meta.classList.add('runlog-header-has-errors');
		}

		if (header.prompt) {
			const prompt = this.headerBlock.appendChild(document.createElement('div'));
			prompt.className = 'runlog-header-prompt';
			prompt.title = localize('runlog.prompt');
			prompt.textContent = header.prompt;
		}
	}

	private renderPlayback(): void {
		clearNode(this.playback);
		const count = this.timeline?.items.length ?? 0;
		this.playback.hidden = count === 0;
		if (count === 0) {
			return;
		}

		const prev = this.playback.appendChild(document.createElement('button'));
		prev.type = 'button';
		prev.className = 'runlog-step-btn';
		prev.title = localize('runlog.stepPrev');
		prev.setAttribute('aria-label', localize('runlog.stepPrev'));
		prev.appendChild(document.createElement('span')).className = 'codicon codicon-chevron-left';
		prev.addEventListener('click', () => this.setStep(this.step - 1));

		const slider = this.playback.appendChild(document.createElement('input'));
		slider.type = 'range';
		slider.className = 'runlog-scrubber';
		slider.min = '0';
		slider.max = String(count - 1);
		slider.value = String(this.step);
		slider.addEventListener('input', () => this.setStep(Number.parseInt(slider.value, 10)));
		this.slider = slider;

		const next = this.playback.appendChild(document.createElement('button'));
		next.type = 'button';
		next.className = 'runlog-step-btn';
		next.title = localize('runlog.stepNext');
		next.setAttribute('aria-label', localize('runlog.stepNext'));
		next.appendChild(document.createElement('span')).className = 'codicon codicon-chevron-right';
		next.addEventListener('click', () => this.setStep(this.step + 1));

		this.positionLabel = this.playback.appendChild(document.createElement('span'));
		this.positionLabel.className = 'runlog-position';
	}

	private renderRow(item: IRunTimelineItem, position: number): HTMLElement {
		const row = document.createElement('button');
		row.type = 'button';
		row.className = `runlog-row runlog-row-${item.kind}`;
		if (item.severity === 'error') {
			row.classList.add('runlog-row-error');
		}
		if (item.kind === 'turn') {
			row.classList.add('runlog-row-boundary');
		}
		row.addEventListener('click', () => this.setStep(position));

		const time = row.appendChild(document.createElement('span'));
		time.className = 'runlog-row-time';
		time.textContent = formatClock(item.ts);

		const badge = row.appendChild(document.createElement('span'));
		badge.className = 'runlog-row-badge';
		badge.textContent = this.badgeText(item);

		const text = row.appendChild(document.createElement('span'));
		text.className = 'runlog-row-text';
		text.textContent = this.rowText(item);

		const metaText = this.rowMeta(item);
		if (metaText !== '') {
			const meta = row.appendChild(document.createElement('span'));
			meta.className = 'runlog-row-meta';
			meta.textContent = metaText;
		}
		return row;
	}

	private badgeText(item: IRunTimelineItem): string {
		switch (item.kind) {
			case 'turn':
				return localize('runlog.turn', String(item.turn));
			case 'stretch':
				return item.stretchKind === 'thinking' ? localize('runlog.thinking') : localize('runlog.replying');
			case 'tool':
				return item.tool?.name ?? item.type;
			case 'usage':
				return localize('runlog.usage');
			default:
				return item.type;
		}
	}

	private rowText(item: IRunTimelineItem): string {
		switch (item.kind) {
			case 'turn':
				return item.ttftMs !== undefined ? localize('runlog.ttft', String(item.ttftMs)) : '';
			case 'stretch':
				return firstLine(item.text ?? '');
			case 'tool': {
				const failed = item.tool?.ok === false ? `${localize('runlog.toolFailed')} · ` : '';
				return failed + firstLine(item.tool?.input ?? '');
			}
			case 'usage': {
				const usage = item.usage;
				return usage
					? [
							usage.inputTokens !== undefined ? `in ${usage.inputTokens}` : undefined,
							usage.outputTokens !== undefined ? `out ${usage.outputTokens}` : undefined,
							usage.cacheReadTokens !== undefined ? `cache ${usage.cacheReadTokens}` : undefined,
						]
							.filter(part => part !== undefined)
							.join(' · ')
					: '';
			}
			default:
				return firstLine(item.message ?? '');
		}
	}

	private rowMeta(item: IRunTimelineItem): string {
		const parts: string[] = [];
		const duration = item.durationMs ?? item.tool?.durationMs;
		if (duration !== undefined) {
			parts.push(formatDuration(duration));
		}
		if (item.chars !== undefined) {
			parts.push(`${item.chars}ch`);
		}
		return parts.join(' · ');
	}

	/** Replay: everything after the step is "the future" — dimmed, not hidden. */
	private setStep(step: number): void {
		const count = this.timeline?.items.length ?? 0;
		if (count === 0) {
			return;
		}
		this.step = Math.min(Math.max(step, 0), count - 1);
		this.applyStep();
	}

	private applyStep(): void {
		const items = this.timeline?.items ?? [];
		for (let i = 0; i < this.rows.length; i++) {
			this.rows[i]!.classList.toggle('runlog-future', i > this.step);
			this.rows[i]!.classList.toggle('selected', i === this.step);
		}
		if (this.slider) {
			this.slider.value = String(this.step);
		}
		if (this.positionLabel) {
			this.positionLabel.textContent = `${this.step + 1} / ${items.length}`;
		}
		this.rows[this.step]?.scrollIntoView({ block: 'nearest' });
		const item = items[this.step];
		if (item) {
			this.renderDetail(item);
		}
	}

	private renderDetail(item: IRunTimelineItem): void {
		clearNode(this.detail);
		this.detail.hidden = false;

		const heading = this.detail.appendChild(document.createElement('div'));
		heading.className = 'runlog-detail-heading';
		heading.textContent = this.badgeText(item);

		const addBlock = (label: string, content: string): void => {
			const block = this.detail.appendChild(document.createElement('div'));
			block.className = 'runlog-detail-block';
			const blockLabel = block.appendChild(document.createElement('div'));
			blockLabel.className = 'runlog-detail-label';
			blockLabel.textContent = label;
			const pre = block.appendChild(document.createElement('pre'));
			pre.className = 'runlog-detail-pre';
			pre.textContent = content;
		};

		if (item.tool?.input !== undefined) {
			addBlock(localize('runlog.detail.input'), item.tool.input);
		}
		if (item.tool?.output !== undefined) {
			addBlock(localize('runlog.detail.output'), item.tool.output);
		}
		if (item.text !== undefined && item.text !== '') {
			addBlock(this.badgeText(item), item.text);
		}
		if (item.message !== undefined && item.message !== '') {
			addBlock(item.type, item.message);
		}
		addBlock(localize('runlog.detail.raw'), item.raw);
	}
}

function firstLine(text: string): string {
	const line = text.split('\n', 1)[0] ?? '';
	return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function formatClock(ts: string): string {
	const date = new Date(ts);
	return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8);
}

function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
