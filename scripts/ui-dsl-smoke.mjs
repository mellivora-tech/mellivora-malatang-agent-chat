/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * #12 M2 真模冒烟:用真实 Kimi 模型产出行式 DSL,量语句级良率与一轮自纠后的
 * 良率。门槛(设计文档 §6):初始 ≥90%,自纠后 ≥98% —— 不达标回评审 JSON 扁平表。
 *
 * 用法: node scripts/ui-dsl-smoke.mjs [modelId ...]   (默认 kimi-k2.7-code)
 * 前置: npx tsc -p tsconfig.json --outDir .smoke-build --noEmit false  (脚本会自动做)
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repo = process.cwd();
const buildDir = join(repo, '.smoke-build');
if (!existsSync(join(buildDir, 'src/sessions/common/uiDsl/parser.js'))) {
	console.log('compiling TS once into .smoke-build …');
	execSync('npx tsc -p tsconfig.json --outDir .smoke-build --noEmit false', { cwd: repo, stdio: 'ignore' });
}
const { parseProgram, statementYield, formatErrors } = await import(join(buildDir, 'src/sessions/common/uiDsl/parser.js'));
const { SMOKE_CATALOG, generateDslPrompt } = await import(join(buildDir, 'src/sessions/common/uiDsl/catalog.js'));

// --- provider config (the user's real coding-plan endpoint) --------------------
const models = JSON.parse(readFileSync(join(homedir(), '.mellivora/models.json'), 'utf8'));
const provider = models.providers.find(p => p.presetId === 'kimi-code' || (p.baseURL ?? '').includes('api.kimi.com/coding'));
if (!provider?.apiKey) {
	console.error('no kimi-code provider with apiKey in ~/.mellivora/models.json');
	process.exit(1);
}
const endpoint = `${provider.baseURL.replace(/\/$/, '')}/v1/messages`;

// --- task set: in-domain UI briefs (no DSL hints — the system prompt is the only
// teacher). Tasks 1–8 are the M2 baseline; 9–11 (#12 M5) exercise the REAL
// workbench vocabulary — field_mapping drag canvas, Table @Editable/@Validate
// capabilities, and the Code artifact — to re-measure yield now that the catalog
// grew past the smoke six. Briefs never name a component: the model must CHOOSE
// the new primitives from the same-source prompt, which is the real test.
const TASKS = [
	'为「订单库迁移」做一个预览界面:标题,一张源字段→目标字段的映射表(至少 5 行,含 order_no→order_id、amt→amount),底部一个「按此执行」按钮,点击后告知你按当前映射执行。',
	'做一个日志筛选面板:一个时间范围下拉(7/30/90 天,默认 7),一个关键字输入框,一个「查询」按钮(点击回传给你重新查询)。',
	'展示一次数据库连接测试的结果:标题「连接测试」,一张表列出 3 个数据源的名称/状态/耗时(其中一个失败),下方一句说明文字。',
	'做一个配置对比视图:标题,一张表对比 dev 与 prod 的 4 个配置项(键/dev 值/prod 值),其中缺失的值用空表示,底部一个「同步到 prod」按钮,点击需回传给你确认执行。',
	'用户要选择导出格式:一句提示文字,一个格式下拉(csv/json/sql,默认 csv),一个文件名输入框,一个「导出」按钮(点击回传)。',
	'展示迁移执行进度报告:标题「执行结果」,表格列出 4 张表的迁移行数与状态,一句总结,一个「查看失败详情」按钮(点击回传)。',
	'做一个数据源新建表单:名称输入框、驱动下拉(mysql/postgres,默认 mysql)、主机输入框、一个「测试连接」按钮(点击回传测试请求)。',
	'展示一份周报摘要卡:标题,三行文字(本周完成/进行中/风险各一行,用小字号),一个「展开完整周报」按钮(点击回传)。',
	// M5 real-vocab briefs:
	'做一个字段映射工作台:源端点是文件 staging_orders.csv(字段 order_no、amt、status),目标端点是数据库表 orders(字段 order_id、amount、state),让我用拖拽把源字段配到目标字段,先把 order_no 配到 order_id。底部一个「生成迁移 SQL」按钮,点击回传给你。',
	'做一个数据校验台:一张表列出 3 行待导入订单(列:订单号、金额、状态),其中金额列允许我就地修改、且必须是纯数字(不是纯数字就高亮提示「金额需为数字」)。底部一个「确认导入」按钮,点击回传。',
	'展示一段待执行的 SQL 产物供我复核:先一句统计文字(将向 orders 写入 128 行),然后一个 SQL 代码块(INSERT ... SELECT ...),最后一个「导出并授权执行」按钮,点击回传给你授权。',
];

const SELF_CORRECT_PROMPT = errors => `你的 DSL 程序有以下解析/校验错误:\n${errors}\n\n请输出修正后的**完整**程序。仍然只输出 DSL 语句,不要任何解释或代码块围栏。`;

async function callModel(model, messages) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify({ model, max_tokens: 2500, system: generateDslPrompt(), messages }),
	});
	if (!response.ok) {
		throw new Error(`${response.status} ${await response.text().catch(() => '')}`);
	}
	const body = await response.json();
	const text = (body.content ?? [])
		.filter(block => block.type === 'text')
		.map(block => block.text)
		.join('');
	const usage = body.usage ?? {};
	return { text, tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) };
}

/** Models wrap in fences despite instructions sometimes — strip but count it. */
function unfence(text) {
	const match = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
	return match ? { text: match[1], fenced: true } : { text: text.trim(), fenced: false };
}

async function runModel(model) {
	const rows = [];
	let tokens = 0;
	for (let index = 0; index < TASKS.length; index++) {
		const task = TASKS[index];
		process.stdout.write(`  [${model}] task ${index + 1}/${TASKS.length} … `);
		let row;
		try {
			const first = await callModel(model, [{ role: 'user', content: [{ type: 'text', text: task }] }]);
			tokens += first.tokens;
			const { text, fenced } = unfence(first.text);
			const program = parseProgram(text, SMOKE_CATALOG);
			const initial = statementYield(program);
			row = { task: index + 1, fenced, initial, initialErrors: program.errors.length, corrected: null };
			if (program.errors.length > 0) {
				const second = await callModel(model, [
					{ role: 'user', content: [{ type: 'text', text: task }] },
					{ role: 'assistant', content: [{ type: 'text', text: first.text }] },
					{ role: 'user', content: [{ type: 'text', text: SELF_CORRECT_PROMPT(formatErrors(program.errors)) }] },
				]);
				tokens += second.tokens;
				const fixed = parseProgram(unfence(second.text).text, SMOKE_CATALOG);
				row.corrected = { ...statementYield(fixed), errors: fixed.errors.length, samples: fixed.errors.slice(0, 3).map(e => e.message) };
			}
			console.log(
				`yield ${initial.valid}/${initial.attempts}${row.initialErrors ? ` (${row.initialErrors} err${row.corrected ? ` → ${row.corrected.errors} after fix` : ''})` : ''}${fenced ? ' [fenced]' : ''}`,
			);
		} catch (error) {
			console.log(`CALL FAILED: ${String(error).slice(0, 120)}`);
			row = { task: index + 1, failed: String(error).slice(0, 300) };
		}
		rows.push(row);
	}
	const ok = rows.filter(row => !row.failed);
	const sum = pick => ok.reduce((total, row) => total + pick(row), 0);
	const initialValid = sum(row => row.initial.valid);
	const initialAttempts = sum(row => row.initial.attempts);
	// Post-correction: corrected program replaces the failed one; clean firsts carry over.
	const finalValid = sum(row => (row.corrected ? row.corrected.valid : row.initial.valid));
	const finalAttempts = sum(row => (row.corrected ? row.corrected.attempts : row.initial.attempts));
	const cleanFirst = ok.filter(row => row.initialErrors === 0).length;
	const cleanFinal = ok.filter(row => (row.corrected ? row.corrected.errors === 0 : row.initialErrors === 0)).length;
	return {
		model,
		tasks: TASKS.length,
		callFailures: rows.length - ok.length,
		initialYield: initialAttempts ? initialValid / initialAttempts : 0,
		finalYield: finalAttempts ? finalValid / finalAttempts : 0,
		cleanFirst,
		cleanFinal,
		fenced: ok.filter(row => row.fenced).length,
		tokens,
		rows,
	};
}

const modelIds = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['kimi-k2.7-code'];
const report = [];
for (const model of modelIds) {
	console.log(`\n== ${model}`);
	report.push(await runModel(model));
}

console.log('\n==== SUMMARY (门槛: 初始 ≥90%, 自纠后 ≥98%) ====');
for (const entry of report) {
	console.log(
		`${entry.model}: 初始语句良率 ${(entry.initialYield * 100).toFixed(1)}% | 自纠后 ${(entry.finalYield * 100).toFixed(1)}% | 首发零错程序 ${entry.cleanFirst}/${entry.tasks} | 自纠后零错 ${entry.cleanFinal}/${entry.tasks} | 围栏违规 ${entry.fenced} | tokens ${entry.tokens}${entry.callFailures ? ` | 调用失败 ${entry.callFailures}` : ''}`,
	);
}
writeFileSync(join(repo, '.smoke-report.json'), JSON.stringify(report, null, 1));
console.log('\nfull report → .smoke-report.json');
