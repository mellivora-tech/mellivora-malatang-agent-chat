/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from '@playwright/test';

// Every spec spreads process.env into its electron.launch — pinning the
// locale here keeps zh-CN assertions honest on any host OS (see main.ts).
process.env['MELLIVORA_LOCALE'] = 'zh-CN';

export default defineConfig({
	testDir: './tests/e2e',
	timeout: 60_000,
	// Each test launches its own Electron app; running them serially avoids
	// relaunch/resource contention, and one retry absorbs residual launch or
	// timing hiccups without masking a genuine, consistently failing test.
	workers: 1,
	retries: 1,
	use: {
		trace: 'retain-on-failure',
	},
});
