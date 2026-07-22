/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Build identity, stamped into the bundle at build time by electron.vite.config's
 * `define`. It answers the one question the logs could never answer before: "is
 * the app that produced this run actually built from the current code, or a
 * stale binary from a launch hours ago?" — an already-running electron holds its
 * main.js in memory, so a later `npm run build` never reaches it. Every run_start
 * now carries this, so a stale-binary run is visible at a glance instead of being
 * reverse-engineered from which tools it happened to call.
 *
 * Un-bundled contexts (unit tests / tsc, where `define` never ran) fall back to
 * 'dev' — `typeof` on the undeclared define is safe and never throws.
 */
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

export const BUILD_SHA: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev';
export const BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev';
