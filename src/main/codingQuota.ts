/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IQuotaSnapshot, IQuotaWindow } from '../sessions/services/models/common/models.js';

/**
 * Coding-plan quota lookup (#19). The Kimi coding plan exposes
 * `GET {base}/v1/usages` (Bearer, same key as chat) with the subscription's
 * weekly usage, rolling windows and reset times. The endpoint is NOT in the
 * official docs — a whole ecosystem of community trackers rides it, but treat
 * it as best-effort everywhere: any failure must degrade to "no quota info",
 * never block a run or a resume.
 */

/** Kimi reports numbers as JSON strings ("100"); absent/malformed → undefined. */
function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** {limit, used?, remaining?, resetTime?} → a complete window, deriving the missing one of used/remaining. */
function toWindow(value: unknown, durationMinutes?: number): IQuotaWindow | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}
	const limit = toNumber(record['limit']);
	let used = toNumber(record['used']);
	let remaining = toNumber(record['remaining']);
	if (limit === undefined || (used === undefined && remaining === undefined)) {
		return undefined;
	}
	used = used ?? Math.max(0, limit - (remaining ?? 0));
	remaining = remaining ?? Math.max(0, limit - used);
	const resetTime = record['resetTime'];
	return {
		used,
		limit,
		remaining,
		...(typeof resetTime === 'string' && resetTime !== '' ? { resetTime } : {}),
		...(durationMinutes !== undefined ? { durationMinutes } : {}),
	};
}

function windowMinutes(window: unknown): number | undefined {
	const record = asRecord(window);
	const duration = toNumber(record?.['duration']);
	if (duration === undefined) {
		return undefined;
	}
	const unit = String(record?.['timeUnit'] ?? '').toUpperCase();
	if (unit.includes('MINUTE')) {
		return duration;
	}
	if (unit.includes('HOUR')) {
		return duration * 60;
	}
	if (unit.includes('DAY')) {
		return duration * 1440;
	}
	return duration;
}

/** Parse the /usages payload. Pure — unit-testable without the network. */
export function parseCodingQuotaPayload(payload: unknown): Pick<IQuotaSnapshot, 'usage' | 'windows'> | undefined {
	const record = asRecord(payload);
	const usage = toWindow(record?.['usage']);
	if (!usage) {
		return undefined;
	}
	const windows: IQuotaWindow[] = [];
	const limits = record?.['limits'];
	if (Array.isArray(limits)) {
		for (const entry of limits) {
			const entryRecord = asRecord(entry);
			const window = toWindow(entryRecord?.['detail'], windowMinutes(entryRecord?.['window']));
			if (window) {
				windows.push(window);
			}
		}
	}
	return { usage, windows };
}

/** The usage endpoint lives beside /v1/messages — mirror createModelClient's URL join, tolerating a baseURL that already ends in /v1. */
export function codingQuotaUrl(baseURL: string): string {
	const base = baseURL.replace(/\/+$/, '');
	return base.endsWith('/v1') ? `${base}/usages` : `${base}/v1/usages`;
}

const QUOTA_TIMEOUT_MS = 10_000;

/** Fetch + parse; undefined on ANY failure (no key, HTTP error, unexpected shape). */
export async function fetchCodingQuota(baseURL: string, apiKey: string): Promise<Pick<IQuotaSnapshot, 'usage' | 'windows'> | undefined> {
	try {
		const response = await fetch(codingQuotaUrl(baseURL), {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
		});
		if (!response.ok) {
			return undefined;
		}
		return parseCodingQuotaPayload(await response.json());
	} catch {
		return undefined;
	}
}

/** Providers whose plan exposes the usage endpoint. Preset id first, URL as the fallback for hand-configured entries. */
export function supportsCodingQuota(provider: { readonly presetId?: string; readonly baseURL: string }): boolean {
	return provider.presetId === 'kimi-code' || provider.baseURL.includes('api.kimi.com/coding');
}

/**
 * A quota/permission failure: every further request this run would fail the
 * same way, so the run must stop IMMEDIATELY (#19 requirement 3) instead of
 * letting parallel children grind on into the same wall. Matches the
 * transport error thrown by the model clients.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /request failed: 403/.test(message);
}
