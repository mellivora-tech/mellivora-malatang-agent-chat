/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { append } from '../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../common/i18n/i18n.js';
import type { IQuotaSnapshot } from '../../services/models/common/models.js';

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

const RING_RADIUS = 6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const REFRESH_INTERVAL_MS = 5 * 60_000;

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
	private readonly fill: SVGCircleElement | null;
	private readonly label: HTMLElement;
	private readonly popover: HTMLElement;
	private inflight = false;
	private disposed = false;

	constructor(private readonly options: IQuotaIndicatorOptions) {
		super();

		const pill = append(options.container, document.createElement('span'));
		pill.className = 'conversation-quota';
		pill.hidden = true;
		pill.innerHTML =
			'<svg viewBox="0 0 16 16" aria-hidden="true">' +
			`<circle class="ring-track" cx="8" cy="8" r="${RING_RADIUS}"></circle>` +
			`<circle class="ring-fill" cx="8" cy="8" r="${RING_RADIUS}" transform="rotate(-90 8 8)" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}"></circle>` +
			'</svg>';
		this.pill = pill;
		this.fill = pill.querySelector<SVGCircleElement>('.ring-fill');
		this.label = append(pill, document.createElement('span'));
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
		void this.options
			.fetchQuota()
			.then(snapshot => this.render(snapshot))
			.catch(() => this.render(undefined))
			.finally(() => {
				this.inflight = false;
			});
	}

	private render(snapshot: IQuotaSnapshot | undefined): void {
		if (this.disposed || !snapshot || snapshot.usage.limit <= 0) {
			this.pill.hidden = true;
			this.hidePopover();
			return;
		}
		const usedPct = Math.round((snapshot.usage.used / snapshot.usage.limit) * 100);
		const leftPct = Math.max(0, 100 - usedPct);
		this.pill.hidden = false;
		this.label.textContent = `${usedPct}%`;
		this.pill.setAttribute('aria-label', localize('quota.aria', usedPct));
		if (this.fill) {
			this.fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * Math.max(0, 1 - usedPct / 100));
		}
		// The ramped severity color drives ring AND text via currentColor;
		// clearing the override returns the pill to the muted toolbar color.
		const severity = quotaSeverityColor(usedPct);
		this.pill.style.color = severity ?? '';

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
				window.durationMinutes !== undefined && window.durationMinutes % 60 === 0
					? localize('quota.windowHours', window.durationMinutes / 60)
					: localize('quota.windowShort');
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
