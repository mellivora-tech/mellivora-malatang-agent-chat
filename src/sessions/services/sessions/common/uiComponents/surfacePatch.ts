/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SMOKE_CATALOG } from '../../../../common/uiDsl/catalog.js';
import { formatErrors, lintBatch } from '../../../../common/uiDsl/parser.js';

/**
 * surface_patch (#12 M4): one batch of line-DSL statements patching the
 * session's workbench surface. The batch must lint CLEAN at the statement
 * level (syntax + catalog); cross-batch reference/root resolution happens at
 * fold time in the renderer — a later batch legitimately references an
 * earlier batch's skeleton and never re-declares root.
 */

export interface ISurfacePatchProps {
	/** Surface identity; one active surface per session in M4. */
	readonly surface: string;
	/** The raw statement batch — persisted verbatim; the surface is a fold over all batches. */
	readonly statements: string;
}

const STATEMENTS_CHAR_CAP = 24_000;
const SURFACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSurfacePatchProps(props: unknown): ISurfacePatchProps | undefined {
	if (typeof props !== 'object' || props === null) {
		return undefined;
	}
	const record = props as Record<string, unknown>;
	const statements = record['statements'];
	if (typeof statements !== 'string' || statements.trim() === '' || statements.length > STATEMENTS_CHAR_CAP) {
		return undefined;
	}
	const surface = record['surface'] ?? 'main';
	if (typeof surface !== 'string' || !SURFACE_ID.test(surface)) {
		return undefined;
	}
	if (lintBatch(statements, SMOKE_CATALOG).length > 0) {
		return undefined;
	}
	return { surface, statements };
}

/** Detailed rejection feedback for the tool's corrective error — the parser's structured hints ARE the self-correction loop. */
export function explainSurfacePatchProps(props: unknown): string | undefined {
	if (typeof props !== 'object' || props === null) {
		return undefined;
	}
	const statements = (props as Record<string, unknown>)['statements'];
	if (typeof statements !== 'string') {
		return undefined;
	}
	if (statements.length > STATEMENTS_CHAR_CAP) {
		return `statements is ${statements.length} chars (cap ${STATEMENTS_CHAR_CAP}) — patch incrementally instead of resending the whole surface`;
	}
	const errors = lintBatch(statements, SMOKE_CATALOG);
	return errors.length > 0 ? `DSL errors:\n${formatErrors(errors)}` : undefined;
}
