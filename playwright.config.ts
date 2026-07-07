/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from '@playwright/test';

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
