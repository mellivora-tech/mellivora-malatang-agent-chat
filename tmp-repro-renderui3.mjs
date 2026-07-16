import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';

const APP_DIR = '/Users/sgx/workspace/code/learning-projects/mellivora-malatang-agent-chat';

const UI_ARGS = JSON.stringify({
	component: 'migration_preview',
	title: '订单迁移映射',
	markdown: '把 user_bak 迁到 user,字段一一对应。',
	props: {
		sourceLabel: 'mysql:user_bak',
		targetLabel: 'mysql:user',
		mappings: [{ source: 'user_bak.username', target: 'user.username', transform: '直接对应' }],
		columns: ['username'],
		sampleRows: [['admin'], ['zhangsan']],
	},
});

// Serve the tool_call ONLY to the first request that carries a `tools` array
// (the agent loop); title-gen and verifier calls get plain text.
let tooledCalls = 0;
const requestKinds = [];
const server = createServer((request, response) => {
	if (request.method === 'GET' && request.url === '/v1/models') {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
		return;
	}
	if (request.method === 'POST' && request.url === '/v1/chat/completions') {
		let raw = '';
		request.on('data', chunk => (raw += String(chunk)));
		request.on('end', () => {
			const body = JSON.parse(raw);
			const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
			const hasRenderUi = hasTools && body.tools.some(t => t.function?.name === 'render_ui');
			requestKinds.push(hasTools ? `tooled(${body.tools.length}${hasRenderUi ? ',render_ui' : ''})` : 'plain');
			response.writeHead(200, { 'content-type': 'text/event-stream' });
			if (hasTools && tooledCalls === 0) {
				tooledCalls += 1;
				response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'render_ui', arguments: UI_ARGS } }] } }] })}\n\n`);
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}/v1`;

const dataDir = await mkdtemp(join(tmpdir(), 'renderui-repro-'));
// A project with a real path → code root exists → createWorkspaceTools (and
// render_ui) registers. Same fixture shape as the e2e specs.
const workDir = await mkdtemp(join(tmpdir(), 'renderui-work-'));
const projectDir = join(dataDir, 'projects', 'repro001');
await mkdir(projectDir, { recursive: true });
await writeFile(join(projectDir, 'project.json'), JSON.stringify({ id: 'repro001', name: 'Repro', path: workDir, createdAt: '2026-07-16T00:00:00.000Z' }), 'utf8');

const app = await electron.launch({ args: ['dist/main/main.js'], cwd: APP_DIR, env: { ...process.env, MELLIVORA_DATA_DIR: dataDir, MELLIVORA_LOG_DIR: join(dataDir, 'logs') } });
const rendererErrors = [];
const page = await app.firstWindow();
page.on('console', m => {
	if (m.type() === 'error') rendererErrors.push(m.text());
});
page.on('pageerror', e => rendererErrors.push('pageerror: ' + e.message));

const report = {};
try {
	await page.setViewportSize({ width: 1400, height: 1000 });
	await page.waitForSelector('.sessions-sidebar');

	await page.locator('.sessions-sidebar-settings-button').click();
	await page.locator('[data-settings-nav-id="models"]').click();
	await page.locator('.sessions-models-provider', { hasText: 'OpenAI' }).click();
	await page.locator('.sessions-models-field-baseurl').fill(baseURL);
	await page.locator('.sessions-models-field-apikey').fill('x');
	await page.locator('.sessions-models-provider-save').click();
	await page.waitForSelector('.sessions-models-model-row');
	await page.locator('.sessions-settings-close').click();

	await page.waitForSelector('.sessions-new-session-view');
	await page.locator('.new-session-input').fill('把 user_bak 迁到 user,先给映射预览');
	await page.locator('.new-session-send-button').click();

	await page.locator('.conversation-message.assistant .conversation-message-text').last().waitFor({ timeout: 30_000 });
	await page.waitForTimeout(1500);

	report.requestKinds = requestKinds;
	report.uiCardInLiveView = await page.locator('.conversation-ui').count();
	report.migrationGridRows = await page.locator('.conversation-ui .tabulator-row').count();
	report.workSteps = await page.locator('.conversation-work-step-label').allInnerTexts().catch(() => []);

	const sessionsDir = join(dataDir, 'projects', 'repro001', 'sessions');
	const files = await readdir(sessionsDir);
	const jsonl = await readFile(join(sessionsDir, files.find(f => f.endsWith('.jsonl'))), 'utf8');
	report.uiEntriesOnDisk = (jsonl.match(/"role":"ui"/g) ?? []).length;
	await page.screenshot({ path: '/private/tmp/claude-501/-Users-sgx-workspace-code-learning-projects-mellivora-malatang-agent-chat/027d7bb0-2e0f-42a0-8dc8-4d43dc11a7c1/scratchpad/shots/50-repro.png', fullPage: true });

	try {
		const logRaw = await readFile(join(dataDir, 'logs', 'latest.jsonl'), 'utf8');
		report.logEvents = logRaw
			.trim()
			.split('\n')
			.map(l => {
				const e = JSON.parse(l);
				return e.type + ':' + (e.name ?? '') + (e.isError ? '!ERR' : '');
			});
	} catch (e) {
		report.logReadError = e.message;
	}
} catch (error) {
	report.error = error.message;
} finally {
	report.rendererErrors = rendererErrors;
	console.log(JSON.stringify(report, null, 2));
	await app.close();
	server.close();
}
