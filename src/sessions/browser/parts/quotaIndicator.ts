/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { IQuotaSnapshot, IQuotaWindow } from '../../services/models/common/models.js';

/**
 * Coding-plan quota pill (#19): a mini ring + used-% label beside the context
 * ring, with a hover popover for the windows and reset times. Hidden whenever
 * no provider exposes a usage endpoint or the lookup fails — quota display is
 * best-effort by contract and must never look like an error.
 */

/** Warning starts here (user-set 2026-07-20); severity then RAMPS to danger at 100%. */
const QUOTA_WARN_THRESHOLD = 70;

/**
 * Below the threshold: no override (inherits the muted toolbar color). From
 * 70% the color ramps warning→danger — a linear color-mix so 71% reads as a
 * nudge and 95% reads as a siren, instead of one flat "warning yellow" for
 * the whole band. Exported for unit tests.
 */
export function quotaSeverityColor(usedPct: number): string | undefined {
	if (!Number.isFinite(usedPct) || usedPct < QUOTA_WARN_THRESHOLD) {
		return undefined;
	}
	const ratio = Math.max(0, Math.min(1, (usedPct - QUOTA_WARN_THRESHOLD) / (100 - QUOTA_WARN_THRESHOLD)));
	const dangerShare = Math.round(ratio * 100);
	return `color-mix(in srgb, var(--vscode-agents-color-danger) ${dangerShare}%, var(--vscode-agents-color-warning))`;
}

/** `2026-07-23T02:55:18Z` → `07-23 10:55`（本地时区）; undefined for garbage. Exported for unit tests. */
export function formatResetTime(iso: string | undefined): string | undefined {
	if (!iso) {
		return undefined;
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return undefined;
	}
	const pad = (value: number): string => String(value).padStart(2, '0');
	return `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
}

/** Time until the reset as the pill's compact countdown — `3d5h` / `3h34m` / `34m`; undefined when past or garbage. Exported for unit tests. */
export function formatCountdown(iso: string | undefined): string | undefined {
	if (!iso) {
		return undefined;
	}
	const deltaMs = new Date(iso).getTime() - Date.now();
	if (Number.isNaN(deltaMs) || deltaMs <= 0) {
		return undefined;
	}
	const totalMinutes = Math.round(deltaMs / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) {
		return `${days}d${hours}h`;
	}
	if (hours > 0) {
		return `${hours}h${minutes}m`;
	}
	return `${minutes}m`;
}

/** How stale the display may claim to be, compactly: `3s前` → `2m前` → `1h前`. Exported for unit tests. */
export function formatAge(ageMs: number): string {
	const seconds = Math.max(0, Math.floor(ageMs / 1000));
	if (seconds < 60) {
		return localize('quota.ageSeconds', seconds);
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return localize('quota.ageMinutes', minutes);
	}
	return localize('quota.ageHours', Math.floor(minutes / 60));
}

const REFRESH_INTERVAL_MS = 5 * 60_000;
const AGE_TICK_MS = 1000;

export interface IQuotaIndicatorOptions {
	/** Toolbar container the pill is appended to. */
	readonly container: HTMLElement;
	/** Resolves the quota snapshot; undefined hides the pill. */
	readonly fetchQuota: () => Promise<IQuotaSnapshot | undefined>;
}

export interface IQuotaIndicator extends Disposable {
	/** Re-fetch now (called on run end — a run is what moves the number). */
	refresh(): void;
}

class QuotaIndicator extends Disposable implements IQuotaIndicator {
	private readonly pill: HTMLElement;
	private readonly ageLabel: HTMLElement;
	private readonly refreshIcon: HTMLElement;
	private readonly dataLine: HTMLElement;
	private readonly popover: HTMLElement;
	private inflight = false;
	private disposed = false;
	/** Epoch ms of the last SUCCESSFUL fetch — drives the freshness line. */
	private fetchedAt: number | undefined;

	constructor(private readonly options: IQuotaIndicatorOptions) {
		super();

		// Layout (user-picked 2026-07-20, round 3): a freshness line over the
		// quota line — `🕐3s前 ⟳` answers "is this 26% NOW?" before the number
		// is trusted, and the button is the "I want it fresh NOW" escape hatch
		// on top of the automatic cadence (run end / focus / 5-minute timer).
		const pill = append(options.container, document.createElement('span'));
		pill.className = 'conversation-quota';
		pill.hidden = true;
		this.pill = pill;

		const status = append(pill, document.createElement('span'));
		status.className = 'conversation-quota-status';
		this.ageLabel = append(status, document.createElement('span'));
		this.ageLabel.className = 'conversation-quota-age';
		const refresh = append(status, document.createElement('button')) as HTMLButtonElement;
		refresh.className = 'conversation-quota-refresh';
		refresh.type = 'button';
		refresh.title = localize('quota.refresh');
		refresh.setAttribute('aria-label', localize('quota.refresh'));
		// codicon-sync (circular arrows), not codicon-refresh: the bundled
		// codicon.css only animates codicon-modifier-spin on sync/loading.
		this.refreshIcon = append(refresh, document.createElement('span'));
		this.refreshIcon.className = 'codicon codicon-sync';
		this.refreshIcon.setAttribute('aria-hidden', 'true');
		refresh.addEventListener('click', () => this.refresh());

		// Both quota horizons merged onto ONE line, short window first (the
		// horizon that bites first leads).
		this.dataLine = append(pill, document.createElement('span'));
		this.dataLine.className = 'conversation-quota-line';

		this._register(
			toDisposable(() => {
				this.disposed = true;
				pill.remove();
			}),
		);

		// Same portal pattern as the context popover: mounted lazily on the
		// workbench root (theme vars live there as inline styles), position:
		// fixed so the composer's overflow can't clip it.
		this.popover = document.createElement('span');
		this.popover.className = 'conversation-context-popover';
		this.popover.setAttribute('role', 'tooltip');
		this._register(toDisposable(() => this.popover.remove()));

		pill.addEventListener('mouseenter', () => this.showPopover());
		pill.addEventListener('mouseleave', () => this.hidePopover());

		const timer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
		this._register(toDisposable(() => clearInterval(timer)));
		// The freshness text ticks locally — cheap textContent write, no fetch.
		const ageTimer = setInterval(() => this.updateAge(), AGE_TICK_MS);
		this._register(toDisposable(() => clearInterval(ageTimer)));
		const onFocus = (): void => this.refresh();
		window.addEventListener('focus', onFocus);
		this._register(toDisposable(() => window.removeEventListener('focus', onFocus)));

		this.refresh();
	}

	refresh(): void {
		if (this.inflight) {
			return;
		}
		this.inflight = true;
		this.refreshIcon.classList.add('codicon-modifier-spin');
		void this.options
			.fetchQuota()
			.then(snapshot => this.render(snapshot))
			.catch(() => this.render(undefined))
			.finally(() => {
				this.inflight = false;
				this.refreshIcon.classList.remove('codicon-modifier-spin');
			});
	}

	private updateAge(): void {
		if (this.fetchedAt !== undefined && !this.pill.hidden) {
			this.ageLabel.textContent = formatAge(Date.now() - this.fetchedAt);
		}
	}

	private render(snapshot: IQuotaSnapshot | undefined): void {
		if (this.disposed || !snapshot || snapshot.usage.limit <= 0) {
			// A failed refresh KEEPS the last data on screen — the freshness
			// line growing stale is the honest signal; blanking would punish
			// a flaky lookup. Hide only when there has never been data.
			if (this.fetchedAt === undefined) {
				this.pill.hidden = true;
				this.hidePopover();
			}
			return;
		}
		const usedPct = Math.round((snapshot.usage.used / snapshot.usage.limit) * 100);
		const leftPct = Math.max(0, 100 - usedPct);
		this.pill.hidden = false;
		this.pill.setAttribute('aria-label', localize('quota.aria', usedPct));
		const parsedFetchedAt = new Date(snapshot.fetchedAt).getTime();
		this.fetchedAt = Number.isNaN(parsedFetchedAt) ? Date.now() : parsedFetchedAt;
		this.updateAge();

		this.dataLine.replaceChildren();
		for (const window of snapshot.windows) {
			const label =
				window.durationMinutes !== undefined && window.durationMinutes % 60 === 0 ? localize('quota.lineHours', window.durationMinutes / 60) : localize('quota.windowShort');
			this.dataLine.append(quotaSegment(label, window));
		}
		this.dataLine.append(quotaSegment(localize('quota.lineWeek'), snapshot.usage));

		this.popover.replaceChildren();
		const header = append(this.popover, document.createElement('span'));
		header.className = 'conversation-context-popover-header';
		const caption = append(header, document.createElement('span'));
		caption.className = 'conversation-context-popover-caption';
		caption.textContent = localize('quota.caption', snapshot.providerName);
		const value = append(header, document.createElement('span'));
		value.className = 'conversation-context-popover-value';
		value.textContent = localize('quota.used', usedPct, leftPct);

		const rows = append(this.popover, document.createElement('span'));
		rows.className = 'conversation-context-breakdown';
		const weeklyReset = formatResetTime(snapshot.usage.resetTime);
		if (weeklyReset) {
			rows.append(quotaRow(localize('quota.resetLabel'), weeklyReset));
		}
		for (const window of snapshot.windows) {
			const label =
				window.durationMinutes !== undefined && window.durationMinutes % 60 === 0 ? localize('quota.windowHours', window.durationMinutes / 60) : localize('quota.windowShort');
			const windowLeft = Math.round((window.remaining / window.limit) * 100);
			const windowReset = formatResetTime(window.resetTime);
			rows.append(quotaRow(label, windowReset ? localize('quota.windowReset', windowLeft, windowReset) : localize('quota.windowLeft', windowLeft)));
		}

		const footnote = append(this.popover, document.createElement('span'));
		footnote.className = 'conversation-context-popover-footnote';
		footnote.textContent = localize('quota.footnote');
	}

	private showPopover(): void {
		if (this.pill.hidden) {
			return;
		}
		if (!this.popover.isConnected) {
			const host = this.pill.closest('.monaco-workbench') ?? document.body;
			host.append(this.popover);
		}
		const pillRect = this.pill.getBoundingClientRect();
		const gap = 6;
		const popoverHeight = this.popover.offsetHeight;
		const popoverWidth = this.popover.offsetWidth;
		const roomAbove = pillRect.top - gap;
		const opensAbove = roomAbove >= popoverHeight || roomAbove >= window.innerHeight - pillRect.bottom - gap;
		const top = opensAbove ? Math.max(8, pillRect.top - gap - popoverHeight) : pillRect.bottom + gap;
		const desiredLeft = pillRect.left + pillRect.width / 2 - popoverWidth / 2;
		const left = Math.max(8, Math.min(desiredLeft, window.innerWidth - popoverWidth - 8));
		this.popover.style.top = `${top}px`;
		this.popover.style.left = `${left}px`;
		this.popover.classList.add('is-visible');
	}

	private hidePopover(): void {
		this.popover.classList.remove('is-visible');
	}
}

/** One quota segment on the data line: `5小时: 25% ⏱3h34m`. The used-% carries the severity color — success below the threshold, the warning→danger ramp above it. */
function quotaSegment(label: string, window: IQuotaWindow): HTMLElement {
	const line = document.createElement('span');
	line.className = 'conversation-quota-segment';
	const labelEl = append(line, document.createElement('span'));
	labelEl.className = 'conversation-quota-line-label';
	labelEl.textContent = `${label}:`;
	const usedPct = window.limit > 0 ? Math.round((window.used / window.limit) * 100) : 0;
	const valueEl = append(line, document.createElement('span'));
	valueEl.className = 'conversation-quota-line-value';
	valueEl.textContent = `${usedPct}%`;
	valueEl.style.color = quotaSeverityColor(usedPct) ?? 'var(--vscode-agents-color-success)';
	const countdown = formatCountdown(window.resetTime);
	if (countdown) {
		const resetEl = append(line, document.createElement('span'));
		resetEl.className = 'conversation-quota-line-reset';
		const clock = append(resetEl, document.createElement('span'));
		clock.className = 'codicon codicon-clock';
		clock.setAttribute('aria-hidden', 'true');
		const time = append(resetEl, document.createElement('span'));
		time.textContent = countdown;
	}
	return line;
}

function quotaRow(label: string, value: string): HTMLElement {
	const row = document.createElement('span');
	row.className = 'conversation-context-breakdown-row';
	const labelEl = append(row, document.createElement('span'));
	labelEl.className = 'conversation-context-breakdown-label';
	labelEl.textContent = label;
	const valueEl = append(row, document.createElement('span'));
	valueEl.className = 'conversation-context-breakdown-value';
	valueEl.textContent = value;
	return row;
}

export function installQuotaIndicator(options: IQuotaIndicatorOptions): IQuotaIndicator {
	return new QuotaIndicator(options);
}
