import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

const n = (value: number) => new Intl.NumberFormat().format(value);
export default function History() {
  const state = useAsync(api.chats);
  const chats = state.data || [];
  const total = chats.reduce((sum, chat) => sum + chat.messages, 0);
  return <Shell><div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-6"><h1 className="page-title mb-0">LINE History</h1><span className="text-text-muted">{chats.length} chats · {n(total)} messages</span></div>
    <AsyncNotice loading={state.loading} error={state.error} label="chat history" />
    {!state.loading && !state.error && (chats.length ? <div className="card p-0">
      <div className="hidden sm:block overflow-x-auto"><table><thead><tr><th>Chat</th><th>Messages</th><th>Webhook</th><th>Imported</th><th>Last seen</th></tr></thead><tbody>{chats.map(chat => <tr key={chat.chat} className="hover:bg-hover"><td className="font-semibold">{chat.chat}</td><td className="font-mono text-accent">{n(chat.messages)}</td><td className="font-mono">{n(chat.webhook)}</td><td className="font-mono">{n(chat.imported)}</td><td className="font-mono text-xs text-text-muted">{chat.last_at.slice(0,10)}</td></tr>)}</tbody></table></div>
      <div className="sm:hidden divide-y divide-border" aria-label="Chat history summary">{chats.map(chat => <article className="px-4 py-4" key={chat.chat}>
        <div className="flex items-start justify-between gap-4"><strong className="leading-snug break-words">{chat.chat}</strong><span className="font-mono text-accent shrink-0">{n(chat.messages)}</span></div>
        <dl className="grid grid-cols-3 gap-3 mt-4"><div><dt className="stat-label mt-0">Webhook</dt><dd className="font-mono text-sm mt-1">{n(chat.webhook)}</dd></div><div><dt className="stat-label mt-0">Imported</dt><dd className="font-mono text-sm mt-1">{n(chat.imported)}</dd></div><div><dt className="stat-label mt-0">Last seen</dt><dd className="font-mono text-[11px] text-text-muted mt-1">{chat.last_at.slice(0,10)}</dd></div></dl>
      </article>)}</div>
    </div> : <div className="card py-20 text-center text-text-muted">No chats in this archive.</div>)}
  </Shell>;
}
