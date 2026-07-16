/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

/**
 * The LIVE render_ui pipeline: model tool_call → agent loop → renderer capture
 * at tool_use → materialize at finalize → persist as role:'ui'. Every other
 * ui-card spec seeds JSONL directly, which is exactly why this chain shipped
 * with zero e2e coverage and its first real failure took a repro harness to
 * find — this spec IS that harness, made permanent. The mock model serves the
 * tool_call only to requests that carry tools (the agent loop); title-gen and
 * verifier calls get plain text — mixing those up swallows the tool_call (the
 * original harness bug, worth this comment).
 */

const UI_ARGS = JSON.stringify({
	component: 'migration_preview',
	title: '订单迁移映射',
	markdown: '把 user_bak 迁到 user,字段一一对应。',
	props: {
		sourceLabel: 'mysql:user_bak',
		targetLabel: 'mysql:user',
		sourceTable: 'test.user_bak',
		targetTable: 'user',
		dialect: 'mysql',
		mappings: [{ source: 'username', target: 'username', transform: '直接对应' }],
		columns: ['username'],
		sampleRows: [['admin'], ['zhangsan']],
	},
});

interface IMockModel {
	readonly baseURL: string;
	close(): Promise<void>;
}

function startMockModel(): Promise<IMockModel> {
	return new Promise(resolve => {
		let tooledCalls = 0;
		const server: Server = createServer((request, response) => {
			if (request.method === 'GET' && request.url === '/v1/models') {
				response.writeHead(200, { 'content-type': 'application/json' });
				response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
				return;
			}
			if (request.method === 'POST' && request.url === '/v1/chat/completions') {
				let raw = '';
				request.on('data', chunk => (raw += String(chunk)));
				request.on('end', () => {
					const body = JSON.parse(raw) as { tools?: unknown[] };
					const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
					response.writeHead(200, { 'content-type': 'text/event-stream' });
					if (hasTools && tooledCalls === 0) {
						tooledCalls += 1;
						response.write(
							`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'render_ui', arguments: UI_ARGS } }] } }] })}\n\n`,
						);
						response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
					} else {
						response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: hasTools ? '映射预览已生成,请审阅。' : 'ok' }, finish_reason: 'stop' }] })}\n\n`);
					}
					response.write('data: [DONE]\n\n');
					response.end();
				});
				return;
			}
			response.writeHead(404).end();
		});
		server.listen(0, '127.0.0.1', () => {
			resolve({
				baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				close: () => new Promise<void>(done => server.close(() => done())),
			});
		});
	});
}

test('a model tool_call becomes a rendered, persisted ui card (capture → materialize → persist)', async () => {
	const mock = await startMockModel();
	const dataDir = await mkdtemp(join(tmpdir(), 'agent-chat-uilive-'));
	// A project with a real path → a code root exists → render_ui registers
	// (it lives in createWorkspaceTools; a rootless chat never sees the tool).
	const workDir = await mkdtemp(join(tmpdir(), 'agent-chat-uilive-work-'));
	const projectDir = join(dataDir, 'projects', 'livep001');
	await mkdir(projectDir, { recursive: true });
	await writeFile(join(projectDir, 'project.json'), JSON.stringify({ id: 'livep001', name: 'Live Repro', path: workDir, createdAt: '2026-07-16T00:00:00.000Z' }), 'utf8');

	let app: ElectronApplication | undefined;
	const rendererErrors: string[] = [];
	try {
		app = await electron.launch({ args: ['dist/main/main.js'], env: { ...process.env, MELLIVORA_DATA_DIR: dataDir } });
		const page = await app.firstWindow();
		page.on('console', message => {
			if (message.type() === 'error') {
				rendererErrors.push(message.text());
			}
		});
		page.on('pageerror', error => rendererErrors.push(error.message));
		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.waitForSelector('.sessions-sidebar');

		// Point the OpenAI preset at the mock (the models e2e's own flow).
		await page.locator('.sessions-sidebar-settings-button').click();
		await page.locator('[data-settings-nav-id="models"]').click();
		await page.locator('.sessions-models-provider', { hasText: 'OpenAI' }).click();
		await page.locator('.sessions-models-field-baseurl').fill(mock.baseURL);
		await page.locator('.sessions-models-field-apikey').fill('x');
		await page.locator('.sessions-models-provider-save').click();
		await page.waitForSelector('.sessions-models-model-row');
		await page.locator('.sessions-settings-close').click();

		await page.waitForSelector('.sessions-new-session-view');
		await page.locator('.new-session-input').fill('把 user_bak 迁到 user,先给映射预览');
		await page.locator('.new-session-send-button').click();

		// The card materializes live, mid-conversation.
		const card = page.locator('.conversation-ui').filter({ hasText: '订单迁移映射' });
		await expect(card).toBeVisible({ timeout: 30_000 });
		await expect(card.locator('.tabulator-row')).toHaveCount(2);
		await expect(page.locator('.conversation-work-step-label').filter({ hasText: 'render_ui migration_preview' })).toHaveCount(1);

		// And persists: the session JSONL carries the role:'ui' entry.
		const sessionsDir = join(projectDir, 'sessions');
		await expect
			.poll(async () => {
				const files = await readdir(sessionsDir).catch(() => [] as string[]);
				const jsonl = files.find(file => file.endsWith('.jsonl'));
				if (!jsonl) {
					return 0;
				}
				const raw = await readFile(join(sessionsDir, jsonl), 'utf8');
				return (raw.match(/"role":"ui"/g) ?? []).length;
			})
			.toBe(1);

		expect(rendererErrors).toEqual([]);
	} finally {
		await app?.close();
		await mock.close();
	}
});
