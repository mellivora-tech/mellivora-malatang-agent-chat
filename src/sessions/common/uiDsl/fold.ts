/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IComponentSpec } from './catalog.js';
import { parseRawStatement, resolveProgram, splitStatements, type DslValue, type IDslError, type IDslStatement } from './parser.js';

/**
 * The fold runtime (#12 M3, design §4): a surface's persisted truth is the
 * ordered list of statement BATCHES the model emitted across turns; its
 * runtime state is a pure fold over them — later batches override by name,
 * references resolve against the ACCUMULATED set (batch 2 may point into
 * batch 1's skeleton: that is the whole incremental-edit promise). Replaying
 * a stored session re-runs this exact fold, so rendering stays a pure
 * function of persisted facts (#14 Q3).
 */

export interface IFoldedSurface {
	/** Merged statements after the fold (name → winning statement). */
	readonly statements: ReadonlyMap<string, IDslStatement>;
	/** Errors attributed across batches (batch index recorded per error). */
	readonly errors: readonly (IDslError & { readonly batch: number })[];
	/** Reactive state defaults ($name → literal). */
	readonly states: ReadonlyMap<string, string | number | boolean | null>;
	/** The resolved render tree from `root`; undefined while no valid root exists. */
	readonly root: ISurfaceNode | undefined;
}

/** A resolved render-tree node: component + args with refs expanded. */
export type SurfaceValue =
	| { readonly kind: 'literal'; readonly value: string | number | boolean | null }
	| { readonly kind: 'state'; readonly name: string }
	| { readonly kind: 'array'; readonly items: readonly SurfaceValue[] }
	| { readonly kind: 'action'; readonly steps: readonly { readonly step: string; readonly args: readonly SurfaceValue[] }[] }
	| { readonly kind: 'cap'; readonly name: string; readonly args: readonly SurfaceValue[] }
	| { readonly kind: 'node'; readonly node: ISurfaceNode }
	| { readonly kind: 'dangling'; readonly name: string };

export interface ISurfaceNode {
	readonly component: string;
	readonly name: string;
	readonly args: readonly SurfaceValue[];
}

export function foldSurface(batches: readonly string[], catalog: readonly IComponentSpec[]): IFoldedSurface {
	const byName = new Map(catalog.map(component => [component.name, component]));
	const statements = new Map<string, IDslStatement>();
	const errors: (IDslError & { batch: number })[] = [];

	for (let batch = 0; batch < batches.length; batch++) {
		for (const { text, line } of splitStatements(batches[batch]!)) {
			const parsed = parseRawStatement(text, line, byName);
			if (parsed.error) {
				errors.push({ ...parsed.error, batch });
			} else if (parsed.statement) {
				statements.set(parsed.statement.name, parsed.statement);
			}
		}
	}

	// Resolution runs on the MERGED map — cross-batch references are the point.
	const resolutionErrors: IDslError[] = [];
	resolveProgram(statements, resolutionErrors);
	errors.push(...resolutionErrors.map(error => ({ ...error, batch: batches.length - 1 })));

	const states = new Map<string, string | number | boolean | null>();
	for (const statement of statements.values()) {
		if (statement.name.startsWith('$') && statement.value.kind === 'literal') {
			states.set(statement.name, statement.value.value);
		}
	}

	const rootStatement = statements.get('root');
	const root =
		rootStatement && rootStatement.value.kind === 'component' ? resolveNode('root', rootStatement.value, statements, new Set(['root']), errors, batches.length - 1) : undefined;

	return { statements, errors, states, root };
}

function resolveNode(
	name: string,
	value: Extract<DslValue, { kind: 'component' }>,
	statements: ReadonlyMap<string, IDslStatement>,
	visiting: Set<string>,
	errors: (IDslError & { batch: number })[],
	batch: number,
): ISurfaceNode {
	return {
		component: value.component,
		name,
		args: value.args.map(arg => resolveValue(arg, statements, visiting, errors, batch)),
	};
}

function resolveValue(
	value: DslValue,
	statements: ReadonlyMap<string, IDslStatement>,
	visiting: Set<string>,
	errors: (IDslError & { batch: number })[],
	batch: number,
): SurfaceValue {
	switch (value.kind) {
		case 'literal':
			return { kind: 'literal', value: value.value };
		case 'state':
			return { kind: 'state', name: `$${value.name}` };
		case 'array':
			return { kind: 'array', items: value.items.map(item => resolveValue(item, statements, visiting, errors, batch)) };
		case 'action':
			return { kind: 'action', steps: value.steps.map(step => ({ step: step.step, args: step.args.map(arg => resolveValue(arg, statements, visiting, errors, batch)) })) };
		case 'cap':
			return { kind: 'cap', name: value.name, args: value.args.map(arg => resolveValue(arg, statements, visiting, errors, batch)) };
		case 'component':
			return { kind: 'node', node: resolveNode('(inline)', value, statements, visiting, errors, batch) };
		case 'ref': {
			const target = statements.get(value.name);
			if (!target || target.value.kind !== 'component') {
				// Dangling ref (already attributed by resolveProgram) or a ref to a
				// non-component — render a hole, never crash the tree.
				return { kind: 'dangling', name: value.name };
			}
			if (visiting.has(value.name)) {
				errors.push({ line: target.line, statement: value.name, message: `circular reference through "${value.name}"`, hint: 'a component cannot contain itself', batch });
				return { kind: 'dangling', name: value.name };
			}
			visiting.add(value.name);
			const node = resolveNode(value.name, target.value, statements, visiting, errors, batch);
			visiting.delete(value.name);
			return { kind: 'node', node };
		}
	}
}
