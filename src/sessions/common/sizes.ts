/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Wang Chao. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerSize } from '../platform/theme/theme.js';

export const agentsFontSizeHeading1 = registerSize('agents.fontSize.heading1', '26px');
export const agentsFontSizeHeading2 = registerSize('agents.fontSize.heading2', '18px');
export const agentsFontSizeHeading3 = registerSize('agents.fontSize.heading3', '13px');
export const agentsFontUi = registerSize('agents.font.ui', "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
export const agentsFontMono = registerSize('agents.font.mono', "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace");
export const agentsFontSizeBody1 = registerSize('agents.fontSize.body1', '13px');
export const agentsFontSizeBody2 = registerSize('agents.fontSize.body2', '11px');
export const agentsFontSizeLabel1 = registerSize('agents.fontSize.label1', '12px');
export const agentsFontSizeLabel2 = registerSize('agents.fontSize.label2', '11px');
export const agentsFontSizeLabel3 = registerSize('agents.fontSize.label3', '10px');
export const agentsFontWeightRegular = registerSize('agents.fontWeight.regular', '400');
export const agentsFontWeightSemiBold = registerSize('agents.fontWeight.semiBold', '600');
export const agentsFontWeightMedium = registerSize('agents.fontWeight.medium', '500');

export const agentsSpace0 = registerSize('agents.space.0', '0px');
export const agentsSpace1 = registerSize('agents.space.1', '1px');
export const agentsSpace2 = registerSize('agents.space.2', '2px');
export const agentsSpace3 = registerSize('agents.space.3', '3px');
export const agentsSpace4 = registerSize('agents.space.4', '4px');
export const agentsSpace5 = registerSize('agents.space.5', '5px');
export const agentsSpace6 = registerSize('agents.space.6', '6px');
export const agentsSpace7 = registerSize('agents.space.7', '7px');
export const agentsSpace8 = registerSize('agents.space.8', '8px');
export const agentsSpace9 = registerSize('agents.space.9', '9px');
export const agentsSpace10 = registerSize('agents.space.10', '10px');
export const agentsSpace11 = registerSize('agents.space.11', '11px');
export const agentsSpace12 = registerSize('agents.space.12', '12px');
export const agentsSpace14 = registerSize('agents.space.14', '14px');
export const agentsSpace16 = registerSize('agents.space.16', '16px');
export const agentsSpace18 = registerSize('agents.space.18', '18px');
export const agentsSpace20 = registerSize('agents.space.20', '20px');
export const agentsSpace22 = registerSize('agents.space.22', '22px');
export const agentsSpace24 = registerSize('agents.space.24', '24px');
export const agentsSpace26 = registerSize('agents.space.26', '26px');
export const agentsSpace28 = registerSize('agents.space.28', '28px');
export const agentsSpace30 = registerSize('agents.space.30', '30px');
export const agentsSpace32 = registerSize('agents.space.32', '32px');
export const agentsSpace34 = registerSize('agents.space.34', '34px');
export const agentsSpace38 = registerSize('agents.space.38', '38px');
export const agentsSpace40 = registerSize('agents.space.40', '40px');
export const agentsSpace42 = registerSize('agents.space.42', '42px');
export const agentsSpace44 = registerSize('agents.space.44', '44px');
export const agentsSpace46 = registerSize('agents.space.46', '46px');
export const agentsSpace48 = registerSize('agents.space.48', '48px');
export const agentsSpace52 = registerSize('agents.space.52', '52px');
export const agentsSpace56 = registerSize('agents.space.56', '56px');
export const agentsSpace68 = registerSize('agents.space.68', '68px');
export const agentsSpace84 = registerSize('agents.space.84', '84px');
export const agentsSpace80 = registerSize('agents.space.80', '80px');
export const agentsSpace86 = registerSize('agents.space.86', '86px');
export const agentsSpace96 = registerSize('agents.space.96', '96px');
export const agentsSpace102 = registerSize('agents.space.102', '102px');
export const agentsSpace180 = registerSize('agents.space.180', '180px');

export const agentsRadiusControl = registerSize('agents.radius.control', '5px');
export const agentsRadiusCompact = registerSize('agents.radius.compact', '4px');
export const agentsRadiusMessage = registerSize('agents.radius.message', '6px');
export const agentsRadiusPanel = registerSize('agents.radius.panel', '8px');
export const agentsRadiusStage = registerSize('agents.radius.stage', '10px');
export const agentsRadiusComposer = registerSize('agents.radius.composer', '9px');
export const agentsRadiusCard = registerSize('agents.radius.card', '7px');
export const agentsRadiusRound = registerSize('agents.radius.round', '999px');
export const agentsRadiusCircle = registerSize('agents.radius.circle', '50%');
export const agentsRadiusContainer = registerSize('agents.radius.container', '10px');

export const agentsSizeIcon = registerSize('agents.size.icon', '16px');
export const agentsSizeStatusDot = registerSize('agents.size.statusDot', '8px');
export const agentsSizeStatusDotLarge = registerSize('agents.size.statusDotLarge', '9px');
export const agentsSizeAction = registerSize('agents.size.action', '26px');
export const agentsSizeActionSmall = registerSize('agents.size.actionSmall', '22px');
export const agentsSizeActionMedium = registerSize('agents.size.actionMedium', '28px');
export const agentsSizeButton = registerSize('agents.size.button', '32px');
export const agentsSizeControl = registerSize('agents.size.control', '34px');
// Layout dimensions shared by the CSS tokens below and the workbench grid
// math (workbench.ts / grid.ts). Defined once as numbers here so the pixel
// tokens and the JS layout can never drift apart.
export const titlebarHeightPx = 52;
export const sidebarWidthPx = 270;
export const auxiliaryBarWidthPx = 340;
export const editorWidthPx = 640;
export const panelHeightPx = 300;
export const conversationWidthPx = 950;
/** The chat column's width cap while the side pane is open: content width plus
 *  both 18px gutters. Anything wider is empty margin, so the grid hands the
 *  surplus to the side pane (diff review, terminal, data grid) instead. */
export const sessionsMaxWidthPx = conversationWidthPx + 2 * 18;

export const agentsSizeTitlebarHeight = registerSize('agents.size.titlebar.height', `${titlebarHeightPx}px`);
export const agentsSizeSidebarWidth = registerSize('agents.size.sidebar.width', `${sidebarWidthPx}px`);
export const agentsSizeSidebarGutter = registerSize('agents.size.sidebar.gutter', '14px');
export const agentsSizeSidebarHeader = registerSize('agents.size.sidebar.header', '148px');
export const agentsSizeSidebarMenuRow = registerSize('agents.size.sidebar.menuRow', '30px');
// 46px lines list titles up with the header menu text axis (icon x22 + 16 icon + 8 gap).
export const agentsSizeSidebarListTitleOffset = registerSize('agents.size.sidebar.listTitleOffset', '46px');
export const agentsSizeSidebarFooter = registerSize('agents.size.sidebar.footer', '48px');
export const agentsSizeStageMargin = registerSize('agents.size.stage.margin', '4px');
export const agentsSizeConversationWidth = registerSize('agents.size.conversation.width', `${conversationWidthPx}px`);
export const agentsSizeComposerWidth = registerSize('agents.size.composer.width', '640px');
export const agentsSizeComposerContextHeight = registerSize('agents.size.composer.contextHeight', '28px');
export const agentsSizeComposerInputHeight = registerSize('agents.size.composer.inputHeight', '106px');
export const agentsSizeComposerToolbarHeight = registerSize('agents.size.composer.toolbarHeight', '42px');
export const agentsSpaceComposerContextGap = registerSize('agents.space.composer.contextGap', '6px');
export const agentsSizeWatermarkWidth = registerSize('agents.size.watermark.width', '390px');
export const agentsSizeWatermarkPrimaryStroke = registerSize('agents.size.watermark.primaryStroke', '178px');
export const agentsSizeWatermarkSecondaryStroke = registerSize('agents.size.watermark.secondaryStroke', '168px');
export const agentsSizeSessionRow = registerSize('agents.size.session.row', '47px');
export const agentsSizeListRow = registerSize('agents.size.list.row', '28px');
export const agentsSizeSettingsHeader = registerSize('agents.size.settings.header', '44px');
export const agentsSizeSettingsNav = registerSize('agents.size.settings.nav', '250px');
export const agentsSizeSettingsCopyMax = registerSize('agents.size.settings.copyMax', '1120px');
