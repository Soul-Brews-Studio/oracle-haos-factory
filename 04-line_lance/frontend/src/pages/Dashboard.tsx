import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

const n = (value: number) => new Intl.NumberFormat().format(value);

export default function Dashboard() {
  const statsState = useAsync(api.stats);
  const tablesState = useAsync(api.tables);
  const chatsState = useAsync(api.chats);
  const stats = statsState.data;
  const tables = tablesState.data;
  const chats = chatsState.data;
  return <Shell><h1 className="page-title">Status</h1>
    <AsyncNotice loading={statsState.loading || tablesState.loading || chatsState.loading} error={statsState.error || tablesState.error || chatsState.error} label="dashboard data" />
    <div className="stats-grid grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {[['Messages', stats?.messages], ['Chats', stats?.chats], ['Vectors', stats?.vectors], ['D1 pages', stats?.files]].map(([label, value]) =>
        <div className="stat-card card" key={String(label)}><div className="stat-val">{typeof value === "number" ? n(value) : '—'}</div><div className="stat-label">{label}</div></div>)}
    </div>
    <div className="grid lg:grid-cols-2 gap-5">
      <section className="card"><h2 className="section-title">Lance Tables</h2><p className="section-copy">Scalar rows stay useful without embeddings. Vectors are a separate derived table.</p>
        <div className="space-y-3 mt-5">{tables?.tables.map(table => <div className="data-row" key={table.name}><div><strong className="font-mono text-accent">{table.name}</strong><div className="text-xs text-text-muted">{table.columns.length} columns</div></div><b className="font-mono">{n(table.rows)}</b></div>)}</div>
      </section>
      <section className="card"><h2 className="section-title">Archive Window</h2><p className="section-copy">Imported from webhook-relay D1 pages with stable record keys.</p>
        <dl className="mt-5 space-y-3 text-sm"><div className="data-row"><dt>First message</dt><dd className="font-mono text-text-muted">{stats?.first?.slice(0,10) || '—'}</dd></div><div className="data-row"><dt>Latest message</dt><dd className="font-mono text-text-muted">{stats?.last?.slice(0,10) || '—'}</dd></div><div className="data-row"><dt>Webhook rows</dt><dd className="font-mono text-accent">{n(stats?.sources.webhook || 0)}</dd></div><div className="data-row"><dt>Historical imports</dt><dd className="font-mono">{n(stats?.sources.import || 0)}</dd></div></dl>
      </section>
    </div>
    <section className="card mt-5"><div className="flex justify-between items-end gap-4"><div><h2 className="section-title">Largest Chats</h2><p className="section-copy">The live relational shape extracted from LanceDB.</p></div><a className="min-h-11 inline-flex items-center text-xs text-accent shrink-0" href="#/history">View history →</a></div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-5 mt-5">{chats?.slice(0,6).map(chat => <div className="chat-summary" key={chat.chat}><div className="font-semibold truncate">{chat.chat}</div><div className="font-mono text-accent mt-1">{n(chat.messages)} <span className="text-[10px] text-text-muted">messages</span></div></div>)}</div>
    </section>
  </Shell>;
}
