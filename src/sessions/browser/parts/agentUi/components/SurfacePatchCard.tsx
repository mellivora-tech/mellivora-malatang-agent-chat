/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import { splitStatements } from '../../../../common/uiDsl/parser.js';
import type { ISurfacePatchProps } from '../../../../services/sessions/common/uiComponents/surfacePatch.js';
import type { IUiCardProps } from '../registry.js';

/**
 * The message-stream PROJECTION of a surface patch (#12 M4, design §5): the
 * transcript keeps a light reference card — statement count, touched names,
 * an open button — while the surface panel is the interaction home. Authority
 * is deliberately inverted relative to ordinary cards.
 */
export function SurfacePatchCard({ props, context }: IUiCardProps<ISurfacePatchProps>): React.ReactElement {
	const names = useMemo(() => {
		const raw = splitStatements(props.statements);
		return raw.map(statement => statement.text.split('=', 1)[0]?.trim() ?? '').filter(name => name !== '');
	}, [props.statements]);

	const preview = names.slice(0, 6).join(', ') + (names.length > 6 ? ' …' : '');
	return (
		<div className="surface-patch-card">
			<div className="surface-patch-card-summary">
				<span className="codicon codicon-window" aria-hidden="true" />
				<span>{localize('surface.patchSummary', names.length)}</span>
				<span className="surface-patch-card-names">{preview}</span>
			</div>
			{context.openSurface ? (
				<button type="button" className="surface-button" onClick={() => context.openSurface?.()}>
					{localize('surface.open')}
				</button>
			) : null}
		</div>
	);
}
