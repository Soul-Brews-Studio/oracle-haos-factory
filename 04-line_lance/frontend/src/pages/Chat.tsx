import { useEffect, useState } from "react";
import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

export default function Chat() {
  const chatsState = useAsync(api.chats);
  const chats = chatsState.data || [];
  const [selected, setSelected] = useState("");
  useEffect(() => { if (!selected && chats.length) setSelected(chats[0].chat); }, [chats, selected]);
  const messagesState = useAsync(
    () => selected ? api.messages({ exact_chat: selected, limit: 100 }) : Promise.resolve(null),
    [selected],
  );
  const messages = messagesState.data;
  return <Shell wide>
    <AsyncNotice loading={chatsState.loading || (!!selected && messagesState.loading)} error={chatsState.error || messagesState.error} label="chat data" />
    <div className="chat-shell card p-0 grid lg:grid-cols-[minmax(240px,390px)_1fr] lg:h-[min(780px,calc(100dvh-180px))] lg:min-h-[560px]">
    <aside aria-label="Chats" className="border-b lg:border-b-0 lg:border-r border-border overflow-y-auto max-h-[240px] lg:max-h-none"><div className="px-4 py-4 lg:px-6 lg:py-5 font-mono text-xs tracking-widest text-text-muted">CHATS ({chats.length})</div>{chats.map(chat => <button type="button" key={chat.chat} onClick={() => setSelected(chat.chat)} aria-pressed={selected === chat.chat} className={`chat-item ${selected === chat.chat ? 'chat-item-active' : ''}`}><div className="flex justify-between gap-3"><strong className="truncate">{chat.chat}</strong><span className="text-xs text-text-muted shrink-0">{chat.messages}</span></div><div className="text-xs text-text-muted truncate mt-1">{chat.last_sender} · {chat.last_text}</div></button>)}</aside>
    <section className="min-w-0 lg:min-h-0 lg:flex lg:flex-col"><div className="p-4 lg:p-6 border-b border-border"><h1 className="text-2xl font-bold break-words">{selected || 'Select a chat'}</h1><div className="text-xs font-mono text-text-muted mt-1">{messagesState.loading ? 'Loading messages…' : `${messages?.total || 0} messages · newest first`}</div></div>
      <div className="divide-y divide-border lg:min-h-0 lg:flex-1 lg:overflow-y-auto">{messages?.messages.map(message => <article key={message.record_key} className="p-4 lg:p-5 flex gap-3 lg:gap-4 hover:bg-hover"><div className="w-9 h-9 lg:w-10 lg:h-10 rounded-full bg-accent-dim text-accent grid place-items-center font-bold shrink-0">{message.sender.slice(0,1)}</div><div className="min-w-0 max-w-[72ch]"><div className="flex flex-wrap items-baseline gap-x-3 gap-y-1"><strong className="text-accent break-words">{message.sender}</strong><span className="font-mono text-xs text-text-muted">{message.sent_at.slice(0,19).replace('T',' ')}</span></div><p className="mt-2 whitespace-pre-wrap break-words">{message.text}</p></div></article>)}</div>
    </section>
  </div></Shell>;
}
