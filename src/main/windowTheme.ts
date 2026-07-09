/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../sessions/common/theme.js';
import { resolveThemeTokenValue, type ThemeId } from '../sessions/platform/theme/theme.js';

export const initialWindowThemeId: ThemeId = 'dark';

export function getInitialWindowBackgroundColor(themeId: ThemeId = initialWindowThemeId): string {
	return resolveThemeTokenValue('agents.color.background', themeId) ?? '#1e1e1e';
}
