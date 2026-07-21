/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createRenderUiTool } from '../../src/main/agent/tools/renderUiTool.js';
import { createWorkspaceTools } from '../../src/main/agent/tools/index.js';
import { appendSessionEntry, createSessionFile, loadSession } from '../../src/main/sessionsStorage.js';
import { toTranscript } from '../../src/sessions/contrib/fileProvider/browser/fileSessionsProvider.js';
import { UI_PROPS_CHAR_CAP, materializeUi, parseUiInput, uiToMarkdown } from '../../src/sessions/services/sessions/common/uiArtifact.js';
import type { ISessionMessage, IUiArtifact } from '../../src/sessions/services/sessions/common/session.js';

// A minimal VALID surface_patch payload — the sole registered component after
// migration_preview's retirement; envelope tests ride on it so they exercise
// the real per-component validator dispatch, not a mock.
const SURFACE_PROPS = {
	surface: 'main',
	statements: 'title = Text("订单迁移映射")',
};

const INPUT = {
	component: 'surface_patch',
	title: '订单迁移映射',
	markdown: '把 legacy_orders 迁到 orders_v2。',
	props: SURFACE_PROPS,
};

// --- parseUiInput (the envelope) ---

test('parseUiInput accepts a valid card and refuses each envelope violation', () => {
	const parsed = parseUiInput(INPUT);
	assert.ok(parsed, 'valid input accepted');
	assert.equal(parsed.component, 'surface_patch');

	assert.equal(parseUiInput(undefined), undefined, 'non-object refused');
	assert.equal(parseUiInput({ ...INPUT, component: 'unknown_thing' }), undefined, 'unregistered component refused');
	assert.equal(parseUiInput({ ...INPUT, title: '  ' }), undefined, 'empty title refused');
	assert.equal(parseUiInput({ ...INPUT, markdown: '' }), undefined, 'empty markdown refused — the fallback/transcript turn can never be blank');
	assert.equal(parseUiInput({ ...INPUT, props: [] }), undefined, 'array props refused');
	assert.equal(parseUiInput({ ...INPUT, props: null }), undefined, 'null props refused');
	assert.equal(parseUiInput({ ...INPUT, props: { ...SURFACE_PROPS, note: 'x'.repeat(UI_PROPS_CHAR_CAP) } }), undefined, 'over-cap props refused');
	assert.equal(parseUiInput({ ...INPUT, props: { statements: 'x = Chart([1])' } }), undefined, 'props failing the component validator refused');
});

test('materializeUi threads the renderer-assigned id; uiToMarkdown carries title + summary', () => {
	const parsed = parseUiInput(INPUT)!;
	const artifact = materializeUi(parsed, 'sess-ui-1');
	assert.equal(artifact.id, 'sess-ui-1');
	assert.equal(artifact.component, 'surface_patch');
	assert.equal(artifact.title, '订单迁移映射');
	assert.deepEqual(artifact.props, SURFACE_PROPS);

	const markdown = uiToMarkdown(parsed);
	assert.match(markdown, /^## 订单迁移映射/);
	assert.match(markdown, /legacy_orders/);
});

// --- render_ui tool ---

test('render_ui is read-only, validates via the envelope, and echoes a one-line confirmation', async () => {
	const tool = createRenderUiTool();
	assert.equal(tool.name, 'render_ui');
	assert.equal(tool.isReadOnly({}), true);

	const ok = tool.validateInput(INPUT);
	assert.ok(ok.ok, 'valid input accepted');
	const result = await tool.call(ok.ok ? ok.value : undefined, { toolUseId: 't', signal: new AbortController().signal });
	assert.match(result.content, /UI card recorded: "订单迁移映射" \(surface_patch\)/);
	assert.match(result.content, /one short sentence/);

	const bad = tool.validateInput({ ...INPUT, component: 'nope' });
	assert.equal(bad.ok, false);
	assert.match(!bad.ok ? bad.error : '', /surface_patch/, 'the corrective error names the available components');
});

test('render_ui is registered in every mode, including plan mode', () => {
	const planTools = createWorkspaceTools(['/tmp'], { includeMutations: false });
	const fullTools = createWorkspaceTools(['/tmp'], { includeMutations: true });
	assert.ok(
		planTools.some(candidate => candidate.name === 'render_ui'),
		'present in plan mode',
	);
	assert.ok(
		fullTools.some(candidate => candidate.name === 'render_ui'),
		'present with mutations',
	);
});

// --- fold passthrough (the role-tax round-trip) ---

test('a ui payload survives the JSONL fold round-trip', async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-chat-ui-'));
	const header = {
		type: 'session',
		version: 1,
		sessionId: 'ui-sess',
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-16T00:00:00.000Z',
		interactivity: 'full',
	} as const;
	await createSessionFile(root, header);

	const parsed = parseUiInput(INPUT)!;
	const ui: IUiArtifact = materializeUi(parsed, 'ui-1');
	await appendSessionEntry(root, { sessionId: 'ui-sess' }, { type: 'message', id: 'm1', role: 'ui', text: uiToMarkdown(parsed), ui, timestamp: '2026-07-16T00:00:01.000Z' });

	const snapshot = await loadSession(root, { sessionId: 'ui-sess' });
	assert.ok(snapshot);
	const message = snapshot.messages.find(candidate => candidate.id === 'm1');
	assert.equal(message?.role, 'ui');
	assert.deepEqual(message?.ui, ui, 'structured payload folded back intact — catches a missing fold spread or isRole entry');
	assert.match(message?.text ?? '', /## 订单迁移映射/, 'markdown fallback folded back');
});

// --- toTranscript mapping ---

test('toTranscript carries a ui message as an assistant turn; empty fallback is dropped', () => {
	const parsed = parseUiInput(INPUT)!;
	const ui = materializeUi(parsed, 'ui-1');
	const messages: ISessionMessage[] = [
		{ id: 'u1', role: 'user', text: '把 A 表迁到 B 表' },
		{ id: 'c1', role: 'ui', text: uiToMarkdown(parsed), ui },
		{ id: 'a1', role: 'assistant', text: '映射预览已给出,请评审。' },
	];

	const transcript = toTranscript(messages);
	assert.equal(transcript.length, 3, 'user + ui(as assistant) + assistant');
	assert.equal(transcript[1]?.role, 'assistant');
	const block = transcript[1]?.content[0];
	assert.ok(block && block.type === 'text' && /订单迁移映射/.test(block.text), 'ui markdown crosses to the model');

	// An empty fallback must not produce an empty turn (400 guard).
	const empty = toTranscript([{ id: 'c2', role: 'ui', text: '   ', ui }]);
	assert.equal(empty.length, 0);
});
