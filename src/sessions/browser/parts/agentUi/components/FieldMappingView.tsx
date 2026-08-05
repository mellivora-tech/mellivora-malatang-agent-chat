/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useMemo } from 'react';
import { ReactFlow, Handle, Position, type Connection, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { connectFieldLink, disconnectFieldLink, type IFieldMappingLink } from '../../../../common/uiDsl/fieldMapping.js';

/**
 * The field_mapping mechanism renderer (#12 M5): a two-column drag-line canvas
 * (@xyflow/react). Source fields on the left, targets on the right; dragging a
 * source handle onto a target creates a 1:1 pairing, deleting an edge removes
 * it. All pairing logic is the pure model in common/uiDsl/fieldMapping — this
 * file only wires xyflow's connect/delete events to it and reports the new
 * links up so the surface can keep them in form state.
 */

const SOURCE_PREFIX = 's:';
const TARGET_PREFIX = 't:';
const ROW_HEIGHT = 44;
const COLUMN_GAP = 240;

type FieldNodeData = { label: string };

function nodeLabel(data: FieldNodeData | undefined): string {
	return data?.label ?? '';
}

function SourceFieldNode({ data }: NodeProps): React.ReactElement {
	return (
		<div className="fm-node fm-node-source">
			<span>{nodeLabel(data as FieldNodeData | undefined)}</span>
			<Handle type="source" position={Position.Right} />
		</div>
	);
}

function TargetFieldNode({ data }: NodeProps): React.ReactElement {
	return (
		<div className="fm-node fm-node-target">
			<Handle type="target" position={Position.Left} />
			<span>{nodeLabel(data as FieldNodeData | undefined)}</span>
		</div>
	);
}

const nodeTypes = { sourceField: SourceFieldNode, targetField: TargetFieldNode };

export interface IFieldMappingViewProps {
	readonly sourceLabel: string;
	readonly sourceFields: readonly string[];
	readonly targetLabel: string;
	readonly targetFields: readonly string[];
	readonly links: readonly IFieldMappingLink[];
	readonly onChange: (links: readonly IFieldMappingLink[]) => void;
}

export function FieldMappingView({ sourceLabel, sourceFields, targetLabel, targetFields, links, onChange }: IFieldMappingViewProps): React.ReactElement {
	const nodes = useMemo<Node[]>(() => {
		const source = sourceFields.map<Node>((field, index) => ({
			id: `${SOURCE_PREFIX}${field}`,
			type: 'sourceField',
			position: { x: 0, y: index * ROW_HEIGHT },
			data: { label: field },
			draggable: false,
		}));
		const target = targetFields.map<Node>((field, index) => ({
			id: `${TARGET_PREFIX}${field}`,
			type: 'targetField',
			position: { x: COLUMN_GAP, y: index * ROW_HEIGHT },
			data: { label: field },
			draggable: false,
		}));
		return [...source, ...target];
	}, [sourceFields, targetFields]);

	const edges = useMemo<Edge[]>(
		() =>
			links.map(link => ({
				id: `${link.source}=>${link.target}`,
				source: `${SOURCE_PREFIX}${link.source}`,
				target: `${TARGET_PREFIX}${link.target}`,
				className: 'fm-edge',
			})),
		[links],
	);

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!connection.source || !connection.target) {
				return;
			}
			onChange(connectFieldLink(links, connection.source.slice(SOURCE_PREFIX.length), connection.target.slice(TARGET_PREFIX.length)));
		},
		[links, onChange],
	);

	const onEdgesDelete = useCallback(
		(deleted: Edge[]) => {
			let next: readonly IFieldMappingLink[] = links;
			for (const edge of deleted) {
				next = disconnectFieldLink(next, edge.source.slice(SOURCE_PREFIX.length), edge.target.slice(TARGET_PREFIX.length));
			}
			onChange(next);
		},
		[links, onChange],
	);

	const height = Math.max(sourceFields.length, targetFields.length, 1) * ROW_HEIGHT + ROW_HEIGHT;

	return (
		<div className="fm-canvas" style={{ height }}>
			<div className="fm-labels">
				<span className="fm-label">{sourceLabel}</span>
				<span className="fm-label">{targetLabel}</span>
			</div>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				onConnect={onConnect}
				onEdgesDelete={onEdgesDelete}
				nodesDraggable={false}
				elementsSelectable
				nodesConnectable
				panOnDrag={false}
				zoomOnScroll={false}
				preventScrolling={false}
				fitView
			/>
		</div>
	);
}
