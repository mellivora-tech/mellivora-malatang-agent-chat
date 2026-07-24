/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The landing heading's satirical time-of-day greetings (#9 i18n scope note):
 * this is FLAVOR CONTENT, not UI chrome — idiomatic dark-humor copy about
 * office culture ("牛马" = workhorse/beast of burden, internet slang). It sits
 * outside the i18n P0 mechanical sweep on purpose: correctly localizing satire
 * is a creative-translation task, not a string swap, and a bad literal
 * translation would read worse than leaving it single-language. Excluded from
 * i18nAudit.test.ts's bare-Chinese-literal check for the same reason the
 * carve-out excludes model-facing tool strings — different category of text.
 *
 * Bitter about the system, never about the user; dark humor keeps the floor.
 */

const LATE_NIGHT_TAILS: readonly string[] = [
	'凌晨的班加了，凌晨的钱一分没见',
	'你在拉磨，老板在睡觉，这就是分工',
	'猝死名单在排队，你这是在插队',
	'这个点干活，图啥？图老板换新车吗',
	'命是自己的，磨是老板的，掂量掂量',
];

const GREETING_BUCKETS: readonly { readonly maxHour: number; readonly label: string; readonly tails: readonly string[] }[] = [
	{ maxHour: 5, label: '凌晨好', tails: LATE_NIGHT_TAILS },
	{
		maxHour: 11,
		label: '早上好',
		tails: ['打卡机不认人，只认牛马', '又是替老板圆梦的一天', '通勤两小时，上班如上坟，说吧', '晨会画的饼，够你饿一天', '太阳照常升起，工资照常不涨'],
	},
	{
		maxHour: 13,
		label: '中午好',
		tails: ['吃快点，磨不等牛', '午饭是成本，你也是成本', '这顿外卖，是你今天唯一的福利', '午休二十分钟，资本家已经觉得亏了', '嚼着预制菜，干着预制的人生'],
	},
	{
		maxHour: 18,
		label: '下午好',
		tails: ['下午三点，灵魂已死，肉体营业', 'KPI 不会疼你，我也只能听你说说', '你困不困老板不管，磨停没停他真管', '咖啡续不动命了，那就续需求吧', '再撑三小时，回棚吃草'],
	},
	{
		maxHour: 23,
		label: '晚上好',
		tails: [
			'下班是违章行为，加班是企业文化',
			'你加的每一个班，都是老板游艇的一块板',
			'晚上十点，灯火通明，全是不敢走的',
			'工资是月抛的，健康是一次性的',
			'这个点还在干，明天老板夸你两句，就两句',
		],
	},
	{ maxHour: 24, label: '凌晨好', tails: LATE_NIGHT_TAILS },
];

function greetingBucket(hour: number): (typeof GREETING_BUCKETS)[number] {
	return GREETING_BUCKETS.find(candidate => hour < candidate.maxHour) ?? GREETING_BUCKETS[GREETING_BUCKETS.length - 1]!;
}

/** e.g. "下午好，下午三点魂飞天，说说你想干啥" — the greeting for this exact hour, tail picked fresh each time the view mounts or the clock enters a new bucket. */
export function pickGreeting(hour: number): string {
	const bucket = greetingBucket(hour);
	const tail = bucket.tails[Math.floor(Math.random() * bucket.tails.length)]!;
	return `${bucket.label}，${tail}`;
}

export function greetingBucketLabel(hour: number): string {
	return greetingBucket(hour).label;
}
