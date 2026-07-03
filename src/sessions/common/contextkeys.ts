/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RawContextKey } from '../platform/contextkey/contextkey.js';

export const IsNewChatSessionContext = new RawContextKey<boolean>('isNewChatSession', true);
export const SessionIdContext = new RawContextKey<string>('sessionId', '');
export const SessionProviderIdContext = new RawContextKey<string>('sessionProviderId', '');
export const SessionTypeContext = new RawContextKey<string>('sessionType', '');
export const SessionWorkspaceIsVirtualContext = new RawContextKey<boolean>('sessionWorkspaceIsVirtual', true);
export const SessionSupportsRenameContext = new RawContextKey<boolean>('sessionSupportsRename', false);
export const SessionSupportsDeleteContext = new RawContextKey<boolean>('sessionSupportsDelete', false);
export const SessionIsCreatedContext = new RawContextKey<boolean>('sessionIsCreated', false);
export const SessionIsStickyContext = new RawContextKey<boolean>('sessionIsSticky', false);
export const SessionSupportsMultipleChatsContext = new RawContextKey<boolean>('sessionSupportsMultipleChats', false);
export const SessionSupportsForkContext = new RawContextKey<boolean>('sessionSupportsFork', false);
export const SessionHasMultipleCommittedChatsContext = new RawContextKey<boolean>('sessionHasMultipleCommittedChats', false);
export const SessionShouldShowChatTabsContext = new RawContextKey<boolean>('sessionShouldShowChatTabs', false);
export const SessionHasMultipleOpenChatsContext = new RawContextKey<boolean>('sessionHasMultipleOpenChats', false);
export const SessionActiveChatIsClosableContext = new RawContextKey<boolean>('sessionActiveChatIsClosable', false);
export const SessionActiveChatIsDeletableContext = new RawContextKey<boolean>('sessionActiveChatIsDeletable', false);
export const SessionIsReadContext = new RawContextKey<boolean>('sessionIsRead', true);
export const SessionIsArchivedContext = new RawContextKey<boolean>('sessionIsArchived', false);
export const SessionHasChangesContext = new RawContextKey<boolean>('sessionHasChanges', false);
export const SessionHasPullRequestContext = new RawContextKey<boolean>('sessionHasPullRequest', false);
export const SessionHasWorkspaceContext = new RawContextKey<boolean>('sessionHasWorkspace', false);
export const IsQuickChatSessionContext = new RawContextKey<boolean>('isQuickChatSession', false);
export const ActiveSessionsContext = new RawContextKey<string>('activeSessions', '');
export const SessionsFocusContext = new RawContextKey<boolean>('sessionsFocus', false);
export const SessionsVisibleContext = new RawContextKey<boolean>('sessionsVisible', false);
export const MultipleSessionsVisibleContext = new RawContextKey<boolean>('multipleSessionsVisible', false);
export const CanGoBackContext = new RawContextKey<boolean>('sessionsCanGoBack', false);
export const CanGoForwardContext = new RawContextKey<boolean>('sessionsCanGoForward', false);
export const EditorMaximizedContext = new RawContextKey<boolean>('editorMaximized', false);
