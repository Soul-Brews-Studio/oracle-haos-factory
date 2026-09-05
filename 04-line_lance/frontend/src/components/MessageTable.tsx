import type { Message } from "../types";

const when = (value: string) => value.replace("T", " ").replace(".000Z", "Z").slice(0, 19);

export default function MessageTable({ messages, compact = false }: { messages: Message[]; compact?: boolean }) {
  if (!messages.length) return <div className="card py-20 text-center text-text-muted">No messages in this slice.</div>;
  return <div className="card p-0">
    <div className="hidden lg:block overflow-x-auto">
      <table className="min-w-[760px]"><thead><tr><th>Time</th><th>Chat / Sender</th><th>Message</th><th>Type</th><th>Source</th></tr></thead>
        <tbody>{messages.map(message => <tr key={message.record_key} className="hover:bg-hover">
          <td className="font-mono text-[11px] text-text-muted whitespace-nowrap">{when(message.sent_at)}</td>
          <td className="max-w-52"><div className="text-sm font-semibold truncate">{message.chat}</div><div className="text-xs text-accent truncate">{message.sender}</div></td>
          <td className={`text-sm whitespace-pre-wrap break-words ${compact ? "max-w-xl line-clamp-2" : "max-w-2xl"}`}>{message.text}</td>
          <td><span className="badge badge-message">{message.type}</span></td>
          <td className="text-[11px] font-mono text-text-muted">{message.source}</td>
        </tr>)}</tbody></table>
    </div>
    <div className="lg:hidden divide-y divide-border" aria-label="Messages">
      {messages.map(message => <article key={message.record_key} className="px-4 py-4 hover:bg-hover">
        <div className="flex items-center justify-between gap-3">
          <time className="font-mono text-[10px] text-text-muted whitespace-nowrap">{when(message.sent_at)}</time>
          <div className="flex items-center gap-2"><span className="badge badge-message">{message.type}</span><span className="font-mono text-[10px] text-text-muted">{message.source}</span></div>
        </div>
        <div className="mt-3 font-semibold leading-snug break-words">{message.chat}</div>
        <div className="mt-1 text-xs text-accent break-words">{message.sender}</div>
        <p className={`mt-3 text-sm leading-relaxed whitespace-pre-wrap break-words ${compact ? "line-clamp-3" : ""}`}>{message.text || `[${message.type.toUpperCase()}]`}</p>
      </article>)}
    </div>
  </div>;
}
