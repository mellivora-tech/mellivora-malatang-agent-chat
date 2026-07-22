/**---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'electron-vite';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';

const root = resolve(import.meta.dirname);

/** Git sha of the source this bundle is built from — stamped into run_start so a stale-binary run is obvious in the logs. */
function gitSha(): string {
	try {
		return execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
	} catch {
		return 'unknown';
	}
}
const BUILD_SHA = gitSha();
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
	main: {
		define: {
			__BUILD_SHA__: JSON.stringify(BUILD_SHA),
			__BUILD_TIME__: JSON.stringify(BUILD_TIME),
		},
		build: {
			outDir: resolve(root, 'dist/main'),
			sourcemap: true,
			rollupOptions: {
				input: resolve(root, 'src/main/main.ts'),
				output: {
					entryFileNames: 'main.js',
					format: 'es',
				},
			},
		},
	},
	preload: {
		build: {
			outDir: resolve(root, 'dist/preload'),
			sourcemap: true,
			rollupOptions: {
				input: resolve(root, 'src/preload/preload.ts'),
				output: {
					entryFileNames: 'preload.js',
					format: 'es',
				},
			},
		},
	},
	renderer: {
		root: resolve(root, 'src/sessions/electron-browser'),
		base: './',
		publicDir: resolve(root, 'public'),
		plugins: [react()],
		resolve: {
			extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
		},
		build: {
			outDir: resolve(root, 'dist/sessions/electron-browser'),
			sourcemap: true,
			rollupOptions: {
				input: {
					sessions: resolve(root, 'src/sessions/electron-browser/sessions.html'),
				},
				output: {
					entryFileNames: 'assets/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]',
				},
			},
		},
	},
});
