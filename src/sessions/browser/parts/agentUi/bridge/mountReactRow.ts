/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * Bridges the transcript's keyed row reconciler (conversationView.ts) to a
 * React-rendered row: same container element for the row's whole lifetime,
 * created once and re-rendered in place — mirrors the imperative patch-in-place
 * contract the reconciler already keeps for hand-built rows, so a row's local
 * UI state (hover, focus, in-progress edits) never restarts on an update.
 */
export function mountOrUpdateReactRow(container: HTMLElement, existingRoot: Root | undefined, node: ReactNode): Root {
	const root = existingRoot ?? createRoot(container);
	root.render(node);
	return root;
}
