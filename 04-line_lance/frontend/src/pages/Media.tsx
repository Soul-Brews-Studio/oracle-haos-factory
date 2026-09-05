import { api } from "../api";
import AsyncNotice from "../components/AsyncNotice";
import MessageTable from "../components/MessageTable";
import Shell from "../components/Shell";
import { useAsync } from "../hooks";

export default function Media() {
  const statsState = useAsync(api.stats);
  const mediaState = useAsync(() => api.messages({ media: 1, limit: 100 }));
  const stats = statsState.data;
  const media = mediaState.data;
  const types = ['image','photo','file','video','audio'];
  return <Shell><h1 className="page-title">Media</h1>
    <AsyncNotice loading={statsState.loading || mediaState.loading} error={statsState.error || mediaState.error} label="media data" />
    <div className="card grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">{types.map(type => <div key={type}><div className="stat-val text-2xl">{stats?.types[type] || 0}</div><div className="stat-label">{type}</div></div>)}<div className="border-l border-border pl-4"><div className="stat-val text-2xl">{media?.total || 0}</div><div className="stat-label">total</div></div></div>
    <div className="mb-3 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-text-muted"><span className="min-w-0 break-words">Media references preserved from D1</span><span className="break-words">showing newest {media?.count || 0}</span></div>{!mediaState.loading && !mediaState.error && media && <MessageTable messages={media.messages} compact />}
  </Shell>;
}
