import Shell from "../components/Shell";

const endpoints = [
  ['GET','/api/health','Add-on identity, version, archive availability, vector count'],
  ['GET','/api/stats','Archive counts, facets, range, vector state'],
  ['GET','/api/messages','Paginated scalar query: q, chat, exact_chat, type, day, media'],
  ['GET','/api/chats','Per-chat counts and latest message metadata'],
  ['GET','/api/tables','Lance schemas, rows, database and import source'],
  ['GET','/api/semantic?q=...','BGE-M3 nearest-neighbor search when line_vectors exists'],
  ['GET','/api/bots','Masked local LINE bot registry'],
  ['POST','/api/bots','Create or update bot configuration through admin Ingress'],
  ['PATCH','/api/bots/:id','Update selected bot fields; omitted secrets are retained'],
  ['DELETE','/api/bots/:id','Remove one bot from the local registry'],
  ['GET','/api/openapi/json','Generated OpenAPI 3 contract'],
];
export default function ApiDocs() {
  const docs = new URL("api/openapi", document.baseURI).toString();
  return <Shell><header className="page-header"><div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="page-title mb-0">API</h1><p className="section-copy mt-2 max-w-[72ch]">Elysia owns the public contract and delegates archive reads to the loopback-only Python LanceDB engine.</p></div><a className="primary-button w-full sm:w-auto" href={docs} target="_blank" rel="noreferrer" aria-label="Open interactive API docs in a new tab">Open interactive docs</a></div></header>
    <section className="card p-0"><div className="px-4 py-4 sm:px-5 border-b border-border"><h2 className="section-title">Contract surface</h2><p className="section-copy">Relative paths remain valid inside Home Assistant Ingress.</p></div><div className="divide-y divide-border">{endpoints.map(([method,path,copy]) => <div className="api-row" key={`${method}-${path}`}><span className={`badge w-fit ${method === 'GET' ? 'badge-group' : 'badge-message'}`}>{method}</span><code className="text-accent break-words">{path}</code><span className="text-sm text-text-muted">{copy}</span></div>)}</div></section>
    <section className="security-panel mt-6"><h2 className="section-title">Access boundary</h2><p>Home Assistant admin Ingress is the only network entry point. Archive endpoints remain read-only; bot mutations use an explicit intent header and never expose stored credentials. No public LINE webhook or Cloudflare route is created here.</p></section></Shell>;
}
