import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

export default function Settings() {
  const state = useAsync(api.tables);
  const data = state.data;
  return <Shell><header className="page-header"><h1 className="page-title mb-0">Settings</h1><p className="section-copy mt-2">Local database identity, import source, and typed Lance contracts.</p></header>
    <AsyncNotice loading={state.loading} error={state.error} label="settings" />
    <section className="card mb-5"><h2 className="section-title">Runtime</h2><dl className="mt-4"><div className="runtime-row"><dt>Database</dt><dd className="font-mono text-xs text-accent break-all">{data?.db_path || '—'}</dd></div><div className="runtime-row"><dt>D1 export source</dt><dd className="font-mono text-xs text-text-muted break-all">{data?.source || '—'}</dd></div><div className="runtime-row"><dt>Embedding model</dt><dd className="font-mono text-xs">@cf/baai/bge-m3 · 1024 dims</dd></div></dl></section>
    <div className="space-y-5">{data?.tables.map(table => <section className="card" key={table.name}><div className="flex flex-wrap justify-between gap-2"><h2 className="min-w-0 break-words font-mono text-xl text-accent">{table.name}</h2><span className="font-mono text-text-muted break-words">{table.rows.toLocaleString()} rows</span></div><div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-5">{table.columns.map(column => <div className="rounded border border-border px-3 py-2" key={column.name}><div className="font-mono text-xs break-words">{column.name}</div><div className="font-mono text-[10px] text-text-muted break-words">{column.type}</div></div>)}</div></section>)}</div>
  </Shell>;
}
