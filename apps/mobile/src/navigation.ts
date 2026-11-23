export type RootStackParamList = {
  Pair: undefined;
  Chats: undefined;
  Chat: { readonly workspaceId: string; readonly sessionId: string; readonly title: string };
  Usage: { readonly workspaceId: string; readonly sessionId: string };
  /** Starts a chat; `workspaceId` preselects the project it was opened from. */
  NewChat: { readonly workspaceId?: string } | undefined;
  Review: { readonly workspaceId: string; readonly sessionId: string };
  Settings: undefined;
};
