/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useMemo, useState } from 'react';
import { localize } from '../../../../common/i18n/i18n.js';
import { SMOKE_CATALOG } from '../../../../common/uiDsl/catalog.js';
import { foldSurface, type ISurfaceNode, type SurfaceValue } from '../../../../common/uiDsl/fold.js';

/**
 * The workbench surface renderer (#12 M4): folds the session's statement
 * batches and renders the tree with the smoke vocabulary. Editing state stays
 * HERE (the three-spec consensus): the model sees it only inside the
 * @ToAssistant snapshot. `formState` holds USER EDITS only — reading falls
 * back to the fold's declared defaults, so @Reset is just "delete the edit".
 */

export interface ISurfacePanelProps {
	readonly batches: readonly string[];
	/** @ToAssistant: the confirm turn (message text + form snapshot) heads back to the model. */
	readonly onToAssistant: (text: string) => void;
}

type FormValue = string | number | boolean | null;

export function SurfacePanel({ batches, onToAssistant }: ISurfacePanelProps): React.ReactElement {
	const folded = useMemo(() => foldSurface(batches, SMOKE_CATALOG), [batches]);
	const [edits, setEdits] = useState<Record<string, FormValue>>({});

	const read = (key: string): FormValue => edits[key] ?? folded.states.get(key) ?? '';

	const snapshot = (): string => {
		const entries: string[] = [];
		for (const [name] of folded.states) {
			entries.push(`${name} = ${JSON.stringify(read(name))}`);
		}
		for (const [key, value] of Object.entries(edits)) {
			if (!key.startsWith('$')) {
				entries.push(`${key} = ${JSON.stringify(value)}`);
			}
		}
		return entries.join('\n');
	};

	const runAction = (steps: readonly { readonly step: string; readonly args: readonly SurfaceValue[] }[]): void => {
		for (const { step, args } of steps) {
			if (step === 'Set' && args[0]?.kind === 'state' && args[1]?.kind === 'literal') {
				const name = args[0].name;
				const value = args[1].value;
				setEdits(previous => ({ ...previous, [name]: value }));
			} else if (step === 'Reset' && args[0]?.kind === 'state') {
				const name = args[0].name;
				setEdits(previous => {
					const next = { ...previous };
					delete next[name];
					return next;
				});
			} else if (step === 'ToAssistant' && args[0]?.kind === 'literal' && typeof args[0].value === 'string') {
				const state = snapshot();
				onToAssistant(state === '' ? args[0].value : `${args[0].value}\n\n<form-state>\n${state}\n</form-state>`);
			}
			// @Run: no local tools are registered in M4 — parsed, ignored.
		}
	};

	const literal = (value: SurfaceValue | undefined): FormValue => (value?.kind === 'literal' ? value.value : null);
	const asText = (value: FormValue): string => (value === null ? '' : String(value));

	const renderValue = (value: SurfaceValue, key: React.Key): React.ReactNode => {
		if (value.kind === 'node') {
			return <SurfaceNodeView key={key} node={value.node} />;
		}
		if (value.kind === 'dangling') {
			return (
				<span key={key} className="surface-hole">
					{localize('surface.hole', value.name)}
				</span>
			);
		}
		if (value.kind === 'literal') {
			return <span key={key}>{asText(value.value)}</span>;
		}
		return null;
	};

	const SurfaceNodeView = ({ node }: { readonly node: ISurfaceNode }): React.ReactElement => {
		switch (node.component) {
			case 'Stack': {
				const children = node.args[0];
				return <div className="surface-stack">{children?.kind === 'array' ? children.items.map((item, index) => renderValue(item, index)) : null}</div>;
			}
			case 'Text': {
				const variant = literal(node.args[1]);
				const className = variant === 'title' ? 'surface-text-title' : variant === 'caption' ? 'surface-text-caption' : 'surface-text-body';
				return <div className={className}>{asText(literal(node.args[0]))}</div>;
			}
			case 'Table': {
				const columns = node.args[0]?.kind === 'array' ? node.args[0].items : [];
				const rows = node.args[1]?.kind === 'array' ? node.args[1].items : [];
				return (
					<table className="surface-table">
						<thead>
							<tr>
								{columns.map((column, index) => (
									<th key={index}>{column.kind === 'literal' ? asText(column.value) : null}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row, rowIndex) => (
								<tr key={rowIndex}>
									{row.kind === 'array' ? row.items.map((cell, cellIndex) => <td key={cellIndex}>{cell.kind === 'literal' ? asText(cell.value) : null}</td>) : null}
								</tr>
							))}
						</tbody>
					</table>
				);
			}
			case 'TextField': {
				const binding = node.args[1]?.kind === 'state' ? node.args[1].name : `#${node.name}`;
				return (
					<label className="surface-field">
						<span>{asText(literal(node.args[0]))}</span>
						<input type="text" value={asText(read(binding))} onChange={event => setEdits(previous => ({ ...previous, [binding]: event.target.value }))} />
					</label>
				);
			}
			case 'Select': {
				const options = node.args[1]?.kind === 'array' ? node.args[1].items : [];
				const binding = node.args[2]?.kind === 'state' ? node.args[2].name : `#${node.name}`;
				return (
					<label className="surface-field">
						<span>{asText(literal(node.args[0]))}</span>
						<select value={asText(read(binding))} onChange={event => setEdits(previous => ({ ...previous, [binding]: event.target.value }))}>
							{options.map((option, index) => (
								<option key={index} value={option.kind === 'literal' ? asText(option.value) : ''}>
									{option.kind === 'literal' ? asText(option.value) : ''}
								</option>
							))}
						</select>
					</label>
				);
			}
			case 'Button': {
				const action = node.args[1];
				return (
					<button type="button" className="surface-button" onClick={() => action?.kind === 'action' && runAction(action.steps)}>
						{asText(literal(node.args[0]))}
					</button>
				);
			}
			default:
				return <div className="surface-hole">{localize('surface.hole', node.component)}</div>;
		}
	};

	if (!folded.root) {
		return <div className="surface-empty">{localize('surface.empty')}</div>;
	}
	return (
		<div className="surface-panel-body">
			<SurfaceNodeView node={folded.root} />
			{folded.errors.length > 0 ? <div className="surface-text-caption">{localize('surface.errorNote', folded.errors.length)}</div> : null}
		</div>
	);
}
