export interface Stats {
  messages: number; chats: number; vectors: number; files: number;
  types: Record<string, number>; sources: Record<string, number>;
  first: string | null; last: string | null;
}

export interface Message {
  record_key: string; source_id: string; chat: string; sender: string; text: string;
  type: string; sent_at: string; source: string; media_ref: string | null;
}

export interface MessageResponse { messages: Message[]; count: number; total: number; offset: number }

export interface ChatSummary {
  chat: string; messages: number; webhook: number; imported: number;
  last_at: string; last_sender: string; last_text: string;
}

export interface TableInfo {
  name: string; rows: number; columns: Array<{ name: string; type: string }>;
}

export interface TablesResponse { tables: TableInfo[]; db_path: string; source: string }

export interface LineBot {
  id: string;
  name: string;
  has_secret: boolean;
  has_token: boolean;
  bot_user_id: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BotInput {
  id: string;
  name: string;
  channel_secret?: string | null;
  channel_access_token?: string | null;
  bot_user_id?: string | null;
  enabled: boolean;
}
