/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The renderer half of the `render_ui` component vocabulary: maps a component
 * name to its props parser (shared with the main-side tool validation, from
 * common/uiComponents) and the React component that renders it. UiCard.tsx
 * resolves through here and falls back to the message's markdown text whenever
 * a name is unregistered or its props fail to parse — so an old build reading
 * a newer session degrades gracefully instead of crashing.
 *
 * Static on purpose (like common/uiComponents): a new component type is one
 * import + one entry here, with no registration timing to get wrong.
 */

import type { ComponentType } from 'react';
import type { ISessionMessage } from '../../../services/sessions/common/session.js';
import { parseMigrationPreviewProps } from '../../../services/sessions/common/uiComponents/migrationPreview.js';
import type { ISessionMessageSender } from '../conversationView.js';
import { MigrationPreviewCard } from './components/MigrationPreviewCard.js';
import { parseSurfacePatchProps } from '../../../services/sessions/common/uiComponents/surfacePatch.js';
import { SurfacePatchCard } from './components/SurfacePatchCard.js';

/** Action surface handed to every ui card — the same bridge PlanCard uses. */
export interface IUiCardContext {
	readonly sessionId: string | undefined;
	readonly messageSender: ISessionMessageSender | undefined;
	readonly onFocusComposer: () => void;
	/** Save-dialog export for a card-produced text artifact (Tier 1: IPC, no model). Absent when the bridge isn't available. */
	readonly exportText?: ((defaultName: string, content: string) => Promise<string | undefined>) | undefined;
	/** Open/focus the workbench-surface tab (#12 M4). Absent when the part service isn't wired. */
	readonly openSurface?: (() => void) | undefined;
}

export interface IUiCardProps<P> {
	readonly message: ISessionMessage;
	readonly props: P;
	readonly context: IUiCardContext;
}

export interface IUiComponentEntry<P> {
	/** Same parser the main-side tool validation ran — re-run here because an on-disk payload may predate a schema change. */
	readonly parseProps: (props: unknown) => P | undefined;
	readonly Component: ComponentType<IUiCardProps<P>>;
}

/** Erases the per-component props type at the registry boundary; parseProps guarantees the runtime match. */
function entry<P>(definition: IUiComponentEntry<P>): IUiComponentEntry<unknown> {
	return definition as unknown as IUiComponentEntry<unknown>;
}

const UI_COMPONENTS: Readonly<Record<string, IUiComponentEntry<unknown>>> = {
	migration_preview: entry({ parseProps: parseMigrationPreviewProps, Component: MigrationPreviewCard }),
	surface_patch: entry({ parseProps: parseSurfacePatchProps, Component: SurfacePatchCard }),
};

export function resolveUiComponent(name: string): IUiComponentEntry<unknown> | undefined {
	return UI_COMPONENTS[name];
}
