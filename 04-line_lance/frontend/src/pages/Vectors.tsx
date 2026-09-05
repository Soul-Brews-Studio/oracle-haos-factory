import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

export default function Vectors() {
  const state = useAsync(api.stats);
  const stats = state.data;
  const count = stats?.vectors || 0;
  return <Shell><h1 className="page-title">Vectors</h1><AsyncNotice loading={state.loading} error={state.error} label="vector status" /><div className="card min-h-[520px] relative overflow-hidden grid place-items-center">
    <div className="vector-grid absolute inset-0 opacity-50" /><div className="relative z-10 max-w-xl text-center px-6"><div className={`mx-auto w-24 h-24 rounded-full border grid place-items-center font-mono text-2xl ${count ? 'accent-orb border-accent text-accent' : 'border-border text-text-muted'}`}>{count}</div>
      <h2 className="text-2xl font-bold mt-6">{count ? 'Semantic index ready' : 'Scalar archive ready; vectors optional'}</h2><p className="section-copy mt-3">Normal browsing, filters, chat history, and media work directly from <code>line_messages</code>. Generate BGE-M3 vectors only when semantic similarity earns its storage and inference cost.</p>
      {!count && <pre className="payload mt-6 text-left">CF_ACCOUNT_ID=... CF_API_TOKEN=... \
.venv/bin/python app.py embed --limit 1000</pre>}
    </div></div></Shell>;
}
