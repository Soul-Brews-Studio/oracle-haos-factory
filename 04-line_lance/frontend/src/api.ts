import type { BotInput, ChatSummary, LineBot, MessageResponse, Stats, TablesResponse } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(new URL(path.replace(/^\//, ""), document.baseURI), init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) message = body.error.replaceAll("_", " ");
    } catch {
      // The status remains useful when an upstream response is not JSON.
    }
    throw new ApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

const get = <T,>(path: string) => request<T>(path);

export const api = {
  stats: () => get<Stats>("api/stats"),
  chats: async () => (await get<{ chats: ChatSummary[] }>("api/chats")).chats,
  tables: () => get<TablesResponse>("api/tables"),
  messages: (params: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") query.set(key, String(value));
    });
    return get<MessageResponse>(`api/messages?${query}`);
  },
  bots: async () => (await get<{ bots: LineBot[] }>("api/bots")).bots,
  saveBot: (bot: BotInput) => request<LineBot>("api/bots", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Line-Lance-Intent": "manage-bots" },
    body: JSON.stringify(bot),
  }),
  updateBot: (id: string, bot: Omit<BotInput, "id">) => request<LineBot>(`api/bots/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Line-Lance-Intent": "manage-bots" },
    body: JSON.stringify(bot),
  }),
  deleteBot: (id: string) => request<{ ok: true }>(`api/bots/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "X-Line-Lance-Intent": "manage-bots" },
  }),
};
