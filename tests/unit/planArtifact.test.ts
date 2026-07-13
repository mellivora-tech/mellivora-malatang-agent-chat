/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createProposePlanTool } from '../../src/main/agent/tools/proposePlanTool.js';
import { appendSessionEntry, createSessionFile, loadSession } from '../../src/main/sessionsStorage.js';
import { toTranscript } from '../../src/sessions/contrib/fileProvider/browser/fileSessionsProvider.js';
import { buildReviseTurn, materializePlan, nextPlanVersion, parsePlanInput, planToMarkdown } from '../../src/sessions/services/sessions/common/planArtifact.js';
import type { IPlanArtifact, ISessionMessage } from '../../src/sessions/services/sessions/common/session.js';

const INPUT = {
	title: 'Add sudo support to the SSH tool',
	sections: [
		{ kind: 'overview', heading: '概述', body: 'Run privileged commands via sudo -S.' },
		{ kind: 'files', heading: '改动文件', items: ['sshTool.ts — sudo branch', 'sshExec.ts — prepend sudo -S'] },
		{ kind: 'risks', heading: '风险', body: 'Credentials cross stdin — never log them.' },
	],
};

// --- propose_plan tool ---

test('propose_plan is read-only, validates sections, echoes a one-line confirmation', async () => {
	const tool = createProposePlanTool();
	assert.equal(tool.name, 'propose_plan');
	assert.equal(tool.isReadOnly({}), true);

	const ok = tool.validateInput(INPUT);
	assert.ok(ok.ok, 'valid input accepted');
	const result = await tool.call(ok.ok ? ok.value : undefined, { toolUseId: 't', signal: new AbortController().signal });
	assert.match(result.content, /Plan recorded: "Add sudo support to the SSH tool" \(3 sections\)/);
	assert.match(result.content, /one short sentence/);

	// The failure modes the model can actually produce.
	assert.equal(tool.validateInput({ title: '', sections: INPUT.sections }).ok, false, 'empty title refused');
	assert.equal(tool.validateInput({ title: 'x', sections: [] }).ok, false, 'empty sections refused');
	assert.equal(tool.validateInput({ title: 'x', sections: [{ kind: 'nope', heading: 'h' }] }).ok, false, 'unknown kind refused');
	assert.equal(tool.validateInput({ title: 'x', sections: [{ kind: 'files', heading: '' }] }).ok, false, 'empty heading refused');
	assert.equal(tool.validateInput({ title: 'x', sections: [{ kind: 'files', heading: 'h', items: [1] }] }).ok, false, 'non-string items refused');
});

// --- materialization ---

test('materializePlan assigns deterministic section ids, version, and draft state', () => {
	const parsed = parsePlanInput(INPUT);
	assert.ok(parsed);
	const plan = materializePlan(parsed, 'plan-1', 2);

	assert.equal(plan.id, 'plan-1');
	assert.equal(plan.version, 2);
	assert.equal(plan.state, 'draft');
	assert.deepEqual(
		plan.sections.map(section => section.id),
		['plan-1-s0', 'plan-1-s1', 'plan-1-s2'],
	);
	assert.equal(plan.sections[1]?.body, '', 'missing body defaults to empty');
	assert.deepEqual(plan.sections[1]?.items, ['sshTool.ts — sudo branch', 'sshExec.ts — prepend sudo -S']);
});

test('planToMarkdown renders headings, bodies, and items; nextPlanVersion counts from the highest', () => {
	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 1);
	const markdown = planToMarkdown(plan);
	assert.match(markdown, /## 实现方案 v1: Add sudo support/);
	assert.match(markdown, /### 改动文件/);
	assert.match(markdown, /- sshTool\.ts — sudo branch/);

	const messages: { plan?: IPlanArtifact }[] = [{}, { plan }, { plan: { ...plan, version: 4 } }];
	assert.equal(nextPlanVersion(messages), 5);
	assert.equal(nextPlanVersion([]), 1);
});

// --- fold passthrough (audit finding F) ---

test('a plan payload survives the JSONL fold round-trip', async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-chat-plan-'));
	const header = {
		type: 'session',
		version: 1,
		sessionId: 'plan-sess',
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-13T00:00:00.000Z',
		interactivity: 'full',
	} as const;
	await createSessionFile(root, header);

	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 1);
	await appendSessionEntry(root, { sessionId: 'plan-sess' }, { type: 'message', id: 'm1', role: 'plan', text: planToMarkdown(plan), plan, timestamp: '2026-07-13T00:00:01.000Z' });

	const snapshot = await loadSession(root, { sessionId: 'plan-sess' });
	assert.ok(snapshot);
	const message = snapshot.messages.find(candidate => candidate.id === 'm1');
	assert.equal(message?.role, 'plan');
	assert.deepEqual(message?.plan, plan, 'structured payload folded back intact');
	assert.match(message?.text ?? '', /## 实现方案 v1/, 'markdown fallback folded back');
});

// --- walkthrough artifact (P3) ---

test('a walkthrough materializes settled (approved), with its own version chain and markdown header', () => {
	const input = parsePlanInput({
		title: 'SSH sudo 支持已完成',
		sections: [
			{ kind: 'files', heading: '改动文件', items: ['sshTool.ts', 'sshExec.ts'] },
			{ kind: 'verify', heading: '如何验证', items: ['npm run test:unit', 'docker sshd 实测 sudo id'] },
		],
	});
	assert.ok(input, 'verify is a valid section kind');
	const walkthrough = materializePlan(input, 'wt-1', 1, 'walkthrough');

	assert.equal(walkthrough.kind, 'walkthrough');
	assert.equal(walkthrough.state, 'approved', 'a walkthrough lands settled, never a draft');
	assert.match(planToMarkdown(walkthrough), /^## 完成小结: SSH sudo 支持已完成/);

	// Version chains are per kind — a walkthrough never bumps plan versions.
	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 3);
	const messages = [{ plan }, { plan: walkthrough }];
	assert.equal(nextPlanVersion(messages, 'plan'), 4);
	assert.equal(nextPlanVersion(messages, 'walkthrough'), 2);
	// A plan without `kind` counts as kind 'plan' (back-compat).
	assert.equal(nextPlanVersion([{ plan: { ...plan, version: 7 } }], 'plan'), 8);
});

// --- planState overlay fold (P1) ---

test('planState entries overlay the plan message; the last entry wins', async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-chat-planstate-'));
	const header = {
		type: 'session',
		version: 1,
		sessionId: 'ps-sess',
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-13T00:00:00.000Z',
		interactivity: 'full',
	} as const;
	await createSessionFile(root, header);

	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 1);
	const ref = { sessionId: 'ps-sess' };
	await appendSessionEntry(root, ref, { type: 'message', id: 'm1', role: 'plan', text: planToMarkdown(plan), plan, timestamp: '2026-07-13T00:00:01.000Z' });
	await appendSessionEntry(root, ref, { type: 'planState', messageId: 'm1', planState: 'approved', timestamp: '2026-07-13T00:00:02.000Z' });

	const approved = await loadSession(root, ref);
	assert.equal(approved?.messages.find(message => message.id === 'm1')?.plan?.state, 'approved');

	await appendSessionEntry(root, ref, { type: 'planState', messageId: 'm1', planState: 'superseded', timestamp: '2026-07-13T00:00:03.000Z' });
	const superseded = await loadSession(root, ref);
	assert.equal(superseded?.messages.find(message => message.id === 'm1')?.plan?.state, 'superseded', 'last planState entry wins');

	// A planState for a message without a plan payload is a harmless no-op.
	await appendSessionEntry(root, ref, { type: 'planState', messageId: 'nope', planState: 'approved', timestamp: '2026-07-13T00:00:04.000Z' });
	const unchanged = await loadSession(root, ref);
	assert.equal(unchanged?.messages.length, 1);
});

// --- planComment fold + buildReviseTurn (P2) ---

test('planComment entries fold into the snapshot; upsert by id resolves', async () => {
	const root = await mkdtemp(join(tmpdir(), 'agent-chat-plancomment-'));
	const header = {
		type: 'session',
		version: 1,
		sessionId: 'pc-sess',
		sessionType: 'agent-chat',
		icon: 'codicon-new-session',
		createdAt: '2026-07-13T00:00:00.000Z',
		interactivity: 'full',
	} as const;
	await createSessionFile(root, header);
	const ref = { sessionId: 'pc-sess' };

	const comment = { id: 'c1', planId: 'plan-1', sectionId: 'plan-1-s1', body: '别在 prod 开 sudo', resolved: false, createdAt: '2026-07-13T00:00:01.000Z' };
	await appendSessionEntry(root, ref, { type: 'planComment', comment, timestamp: '2026-07-13T00:00:01.000Z' });

	const open = await loadSession(root, ref);
	assert.equal(open?.planComments?.length, 1);
	assert.equal(open?.planComments?.[0]?.resolved, false);

	await appendSessionEntry(root, ref, { type: 'planComment', comment: { ...comment, resolved: true }, timestamp: '2026-07-13T00:00:02.000Z' });
	const resolved = await loadSession(root, ref);
	assert.equal(resolved?.planComments?.length, 1, 'upsert by id, not append');
	assert.equal(resolved?.planComments?.[0]?.resolved, true, 'last entry wins');

	// A malformed comment entry is dropped whole, never half-parsed.
	await appendSessionEntry(root, ref, { type: 'planComment', comment: { id: 'bad' }, timestamp: '2026-07-13T00:00:03.000Z' } as never);
	const after = await loadSession(root, ref);
	assert.equal(after?.planComments?.length, 1);
});

test('buildReviseTurn quotes open comments by section heading; empty when all resolved', () => {
	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 2);
	const filesSection = plan.sections[1]!;
	const comments = [
		{ id: 'c1', planId: 'plan-1', sectionId: filesSection.id, body: '别动 authService', resolved: false, createdAt: new Date() },
		{ id: 'c2', planId: 'plan-1', sectionId: plan.sections[2]!.id, body: '风险还要补日志脱敏', resolved: false, createdAt: new Date() },
		{ id: 'c3', planId: 'plan-1', sectionId: filesSection.id, body: '已处理过的', resolved: true, createdAt: new Date() },
		{ id: 'c4', planId: 'OTHER-plan', sectionId: 'x', body: '别的版本的', resolved: false, createdAt: new Date() },
	];

	const turn = buildReviseTurn(plan, comments);
	assert.ok(turn);
	assert.match(turn, /实现方案 v2/);
	assert.match(turn, /\[改动文件\] 别动 authService/);
	assert.match(turn, /\[风险\] 风险还要补日志脱敏/);
	assert.doesNotMatch(turn, /已处理过的/, 'resolved comments stay out');
	assert.doesNotMatch(turn, /别的版本的/, 'other plans stay out');
	assert.match(turn, /重新调用 propose_plan/);

	assert.equal(
		buildReviseTurn(
			plan,
			comments.map(candidate => ({ ...candidate, resolved: true })),
		),
		undefined,
		'nothing open → undefined',
	);
});

// --- toTranscript mapping (audit finding E) ---

test('toTranscript carries a plan message as an assistant turn; work stays dropped', () => {
	const plan = materializePlan(parsePlanInput(INPUT)!, 'plan-1', 1);
	const messages: ISessionMessage[] = [
		{ id: 'u1', role: 'user', text: '给 SSH 工具加 sudo 支持' },
		{ id: 'w1', role: 'work', text: '', steps: [{ kind: 'tool', label: 'propose_plan', durationMs: 10 }] },
		{ id: 'p1', role: 'plan', text: planToMarkdown(plan), plan },
		{ id: 'a1', role: 'assistant', text: '方案已给出,请评审。' },
	];

	const transcript = toTranscript(messages);
	assert.equal(transcript.length, 3, 'user + plan(as assistant) + assistant; work dropped');
	assert.equal(transcript[1]?.role, 'assistant');
	const block = transcript[1]?.content[0];
	assert.ok(block && block.type === 'text' && /## 实现方案 v1/.test(block.text), 'plan markdown crosses to the model');

	// A plan message with an empty fallback must not produce an empty turn (400 guard).
	const empty = toTranscript([{ id: 'p2', role: 'plan', text: '   ' }]);
	assert.equal(empty.length, 0);
});
