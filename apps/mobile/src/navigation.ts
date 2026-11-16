export type RootStackParamList = {
  Pair: undefined;
  Chats: undefined;
  Chat: { readonly workspaceId: string; readonly sessionId: string; readonly title: string };
  Usage: { readonly workspaceId: string; readonly sessionId: string };
};
