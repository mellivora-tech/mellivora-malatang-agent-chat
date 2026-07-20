/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveLocale, localize } from './i18n/i18n.js';

/** Compact relative time (now/5m/3h/2d, then a short date). Extracted from
 *  sessionsList so the artifacts panel shares one clock with the sidebar (#13 P1). */
export function formatTimestamp(date: Date): string {
	const diff = Date.now() - date.getTime();
	const minutes = Math.max(0, Math.floor(diff / 60000));
	if (minutes < 1) {
		return localize('time.now');
	}
	if (minutes < 60) {
		return localize('time.minutes', minutes);
	}

	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return localize('time.hours', hours);
	}

	const days = Math.floor(hours / 24);
	if (days < 7) {
		return localize('time.days', days);
	}

	// The APP locale, not the OS locale — a pinned en-US must not show 中文 dates (#9 P1).
	return date.toLocaleDateString(getActiveLocale(), { month: 'short', day: 'numeric' });
}
