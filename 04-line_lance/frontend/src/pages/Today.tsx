import { useState } from "react";
import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import MessageTable from "../components/MessageTable";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

export default function Today() {
  const statsState = useAsync(api.stats);
  const stats = statsState.data;
  const day = stats?.last?.slice(0, 10) || "";
  const [type, setType] = useState("");
  const resultState = useAsync(() => day ? api.messages({ day, type, limit: 100 }) : Promise.resolve(null), [day, type]);
  const result = resultState.data;
  return <Shell><div className="flex flex-wrap items-baseline gap-3 mb-6"><h1 className="page-title mb-0">Latest Day</h1><span className="font-mono text-text-muted">{day || '—'} archive snapshot</span></div>
    <AsyncNotice loading={statsState.loading || resultState.loading} error={statsState.error || resultState.error} label="latest messages" />
    <div className="flex flex-wrap items-center gap-3 mb-5"><div className="text-4xl font-mono font-bold text-accent">{result?.total ?? '—'}</div><span className="stat-label">messages</span>
      <label className="ml-auto flex items-center gap-2 text-xs text-text-muted"><span className="sr-only">Message type</span><select aria-label="Message type" className="control" value={type} onChange={e => setType(e.target.value)}><option value="">All types</option>{Object.keys(stats?.types || {}).map(value => <option key={value}>{value}</option>)}</select></label></div>
    {!resultState.loading && !resultState.error && result && <MessageTable messages={result.messages} compact />}
  </Shell>;
}
