(function () {
  const R=window.React, RD=window.ReactDOM, h=R&&R.createElement, root=document.getElementById('timeline-root');
  const KEY='__dc_superuser_auth__';
  if(!R||!RD||!h){root.textContent='Unable to load the timeline. Check the network connection and reload.';return;}
  const {useEffect,useMemo,useRef,useState}=R;
  const M=window.DCTimelineModel, T=window.DCTime;
  const params=new URLSearchParams(location.search);
  const c=(tag,props,...children)=>h(tag,props,...children);
  async function rawApi(path,options={}){const response=await fetch('./'+path,{cache:'no-store',...options});const body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(body.error||body.message||`Request failed (${response.status})`),{body,status:response.status});return body;}
  async function signIn(){try{const fresh=await rawApi('api/discord/admin-token',{method:'POST'});localStorage.setItem(KEY,JSON.stringify(fresh));return fresh.token;}catch(error){const saved=JSON.parse(localStorage.getItem(KEY)||'{}');if(!saved.token)throw error;const fresh=await rawApi('api/collections/_superusers/auth-refresh',{method:'POST',headers:{Authorization:saved.token}});localStorage.setItem(KEY,JSON.stringify(fresh));return fresh.token;}}
  const tokenRef={current:''};
  async function api(path,options={}){const send=()=>rawApi(path,{...options,headers:{...(options.headers||{}),...(tokenRef.current?{Authorization:tokenRef.current}:{})}});try{return await send();}catch(error){if(error.status!==401||!tokenRef.current)throw error;tokenRef.current=await signIn();return await send();}}
  function keepIngressAlive(){try{if(window.parent===window)return()=>{};const hass=()=>window.parent.document.querySelector('home-assistant')?.hass;if(!hass())return()=>{};const session=()=>(document.cookie.match(/(?:^|; )ingress_session=([^;]+)/)||[])[1];const tick=async()=>{const s=session();if(!s)return;try{await hass().callWS({type:'supervisor/api',endpoint:'/ingress/validate_session',method:'post',data:{session:s}});}catch(_){}};const timer=setInterval(tick,60000);tick();return()=>clearInterval(timer);}catch(_){return()=>{};}}
  class SSEDecoder{constructor(){this.buffer='';}feed(chunk){this.buffer+=chunk;this.buffer=this.buffer.replace(/\r\n/g,'\n').replace(/\r(?!$)/g,'\n');const events=[];let boundary;while((boundary=this.buffer.indexOf('\n\n'))!==-1){const block=this.buffer.slice(0,boundary);this.buffer=this.buffer.slice(boundary+2);let event='message';const data=[];for(const line of block.split('\n')){if(line.startsWith('event:'))event=line.slice(6).trimStart();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}if(data.length)events.push({event,data:data.join('\n')});}return events;}}

  const KIND_STYLE={message:'bg-slate-700 text-slate-200',thread:'bg-indigo-900 text-indigo-200',import:'bg-emerald-900 text-emerald-200'};
  const clock=(ts)=>{const d=T?.date?T.date(ts):new Date(ts);return d?d.toLocaleTimeString('en-GB',{timeZone:'Asia/Bangkok',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}):'--:--:--';};
  const roomHref=(event)=>'./simple.html?guild='+encodeURIComponent(event.guild_id||'')+'&room='+encodeURIComponent(event.thread_id||event.channel_id||'');

  function Row({event,now,expanded,toggle}) {
    const long=(event.text||'').length>280;
    const body=expanded||!long?event.text:event.text.slice(0,280)+'…';
    return c('article',{'data-event-key':event.key,'data-kind':event.kind,className:'grid grid-cols-[76px_minmax(0,1fr)] gap-3 border-b border-slate-800/80 px-3 py-2 hover:bg-slate-900/60 sm:grid-cols-[76px_260px_minmax(0,1fr)]'},
      c('time',{dateTime:event.ts,title:T?.absolute(event.ts)||event.ts,className:'mono pt-0.5 text-xs text-slate-400'},clock(event.ts),c('div',{className:'text-[10px] text-slate-600'},T?.relative(event.ts,now)||'')),
      c('div',{className:'min-w-0 text-xs sm:pt-0.5'},
        c('span',{className:'mr-1 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide '+(KIND_STYLE[event.kind]||KIND_STYLE.message)},event.kind),
        c('a',{href:roomHref(event),title:'Open this room',className:'text-slate-300 hover:text-white hover:underline'},M.sourceLabel(event))),
      c('div',{className:'min-w-0 sm:col-start-3'},
        c('div',{className:'flex flex-wrap items-baseline gap-x-2 text-xs'},
          c('strong',{className:'text-slate-100'},event.author||event.author_id||'—'),
          event.bot?c('span',{className:'rounded bg-slate-800 px-1 text-[10px] text-slate-400'},'bot'):null,
          event.edited?c('span',{className:'rounded bg-amber-900/60 px-1 text-[10px] text-amber-200'},'edited'):null,
          event.deleted?c('span',{className:'rounded bg-rose-900/60 px-1 text-[10px] text-rose-200'},'deleted'):null,
          event.attachments?c('span',{className:'rounded bg-slate-800 px-1 text-[10px] text-slate-400'},event.attachments+' file'+(event.attachments>1?'s':'')):null,
          event.reply_to?c('span',{className:'text-[10px] text-slate-500'},'reply'):null),
        c('p',{className:'whitespace-pre-wrap break-words text-sm leading-6 '+(event.deleted?'italic text-slate-500':'text-slate-300')},event.deleted&&!event.text?'(deleted message)':body||'[no text]'),
        long?c('button',{type:'button',onClick:toggle,className:'text-[11px] text-indigo-300 hover:underline'},expanded?'Show less':'Show more'):null));
  }
  function SystemStrip({system,live,liveState,now}) {
    const gw=system?.live_status||{}, job=system?.backfill||{};
    const dot=(ok)=>c('span',{className:'inline-block h-2 w-2 rounded-full '+(ok?'bg-emerald-400':'bg-slate-500')});
    return c('div',{className:'flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-slate-800 bg-slate-950/80 px-4 py-2 text-xs text-slate-400'},
      c('span',{className:'flex items-center gap-2'},dot(gw.connected),'gateway ',gw.connected?'connected':(gw.state||'off'),gw.connected_since?c('span',{className:'text-slate-600'},'since '+(T?.absolute(gw.connected_since)||gw.connected_since)):null),
      c('span',{className:'flex items-center gap-2'},dot(job.state==='running'),'backfill ',job.state||'unknown',job.finished_at?c('span',{className:'text-slate-600'},T?.relative(job.finished_at,now)||''):job.started_at?c('span',{className:'text-slate-600'},'started '+(T?.relative(job.started_at,now)||'')):null),
      c('span',{className:'flex items-center gap-2'},dot(live&&liveState==='connected'),'live updates ',live?liveState:'off'));
  }
  function App(){
    const [token,setToken]=useState(''),[sidebar,setSidebar]=useState(null),[events,setEvents]=useState([]),[system,setSystem]=useState(null),[state,setState]=useState('Connecting through Home Assistant…'),[busy,setBusy]=useState(false);
    const [window_,setWindow]=useState(params.get('window')||'24h'),[kinds,setKinds]=useState(['message','thread','import']),[q,setQ]=useState(params.get('q')||''),[guilds,setGuilds]=useState(null),[live,setLive]=useState(params.get('live')!=='0'),[liveState,setLiveState]=useState('off');
    const [nextBefore,setNextBefore]=useState(null),[hasMore,setHasMore]=useState(false),[expanded,setExpanded]=useState({}),[now,setNow]=useState(Date.now());
    const names=useMemo(()=>M.nameIndex(sidebar),[sidebar]);
    const visibleGuilds=useMemo(()=>sidebar?sidebar.guilds.filter(g=>!g.hidden):[],[sidebar]);
    const selected=guilds||visibleGuilds.map(g=>g.id);
    const filter={guilds:selected,kinds,since:M.sinceFor(window_,now),q};
    useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),30000);const stop=keepIngressAlive();return()=>{clearInterval(t);stop();};},[]);
    useEffect(()=>{if(!token)return;const t=setInterval(async()=>{if(document.hidden)return;try{tokenRef.current=await signIn();}catch(_){}},60000);return()=>clearInterval(t);},[token]);
    useEffect(()=>{(async()=>{try{tokenRef.current=await signIn();setToken(tokenRef.current);const side=await api('api/dc/sidebar');setSidebar(side);const g=params.get('guild');if(g){const found=side.guilds.find(x=>x.id===g||x.name.toLowerCase()===g.toLowerCase());if(found)setGuilds([found.id]);}}catch(error){setState(error.body?.haUser?`Home Assistant user ${error.body.haUser.id||''} is not allowed: ${error.message}`:error.message);}})();},[]);
    const query=(extra={})=>{const p=new URLSearchParams({limit:'100',kinds:kinds.join(',')});const since=M.sinceFor(window_,Date.now());if(since)p.set('since',since);if(selected.length&&sidebar&&selected.length<sidebar.guilds.length)p.set('guilds',selected.join(','));if(q.trim())p.set('q',q.trim());for(const [k,v] of Object.entries(extra))p.set(k,v);return 'api/dc/timeline?'+p.toString();};
    const load=async()=>{if(!token||!sidebar)return;setBusy(true);try{setState('Loading…');const data=await api(query());setEvents(data.events);setSystem(data.system);setNextBefore(data.next_before);setHasMore(data.has_more);setState(`${data.events.length} events · ${selected.length} of ${sidebar.guilds.length} servers · ${window_}`);}catch(error){setState(error.message);}finally{setBusy(false);}};
    const older=async()=>{if(!nextBefore)return;setBusy(true);try{const data=await api(query({before:nextBefore}));setEvents(prev=>prev.concat(data.events.filter(ev=>!prev.some(p=>p.key===ev.key))));setNextBefore(data.next_before);setHasMore(data.has_more);}catch(error){setState(error.message);}finally{setBusy(false);}};
    useEffect(()=>{load();},[token,sidebar,window_,kinds.join(','),(guilds||[]).join(','),q]);
    // Live: PocketBase realtime on discord_messages, resolved to the same event shape.
    useEffect(()=>{if(!live||!token||!sidebar){setLiveState(live?'connecting':'off');return;}let stopped=false;const controller=new AbortController();(async()=>{while(!stopped){let reader=null;try{setLiveState('connecting');const response=await fetch('./api/realtime',{headers:{Accept:'text/event-stream',Authorization:tokenRef.current},signal:controller.signal,cache:'no-store'});if(!response.ok||!response.body)throw new Error('HTTP '+response.status);reader=response.body.getReader();const text=new TextDecoder(),decoder=new SSEDecoder();let subscribed=false;while(!stopped){const part=await reader.read();if(part.done)break;for(const ev of decoder.feed(text.decode(part.value,{stream:true}))){let data;try{data=JSON.parse(ev.data);}catch(_){continue;}if(ev.event==='PB_CONNECT'){const sub=await fetch('./api/realtime',{method:'POST',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:tokenRef.current,'Content-Type':'application/json'},body:JSON.stringify({clientId:data.clientId,subscriptions:['discord_messages/*']})});if(!sub.ok)throw new Error('subscription HTTP '+sub.status);subscribed=true;setLiveState('connected');continue;}if(!subscribed||(ev.event!=='discord_messages/*'&&ev.event!=='discord_messages'))continue;if(!['create','update','delete'].includes(data.action)||!data.record)continue;const event=M.recordEvent(data.record,names);if(!event)continue;if(data.action==='delete')event.deleted=true;setEvents(prev=>M.matches(event,{guilds:selected,kinds,q})?M.upsert(prev,event):prev);}}}catch(error){try{await reader?.cancel();}catch(_){}if(stopped)break;setLiveState('reconnecting');}if(!stopped)await new Promise(r=>setTimeout(r,2000));}})();return()=>{stopped=true;controller.abort();setLiveState('off');};},[live,token,sidebar,names,selected.join(','),kinds.join(','),q]);
    const groups=useMemo(()=>M.groupByDay(events.filter(ev=>M.matches(ev,{kinds,q})),ts=>T?.bangkokDay(ts)||String(ts||'').slice(0,10)),[events,kinds,q]);
    const toggleKind=(kind)=>setKinds(prev=>prev.includes(kind)?prev.filter(k=>k!==kind):[...prev,kind]);
    const toggleGuild=(id)=>setGuilds(prev=>{const base=prev||visibleGuilds.map(g=>g.id);return base.includes(id)?base.filter(x=>x!==id):[...base,id];});
    const chip=(active,label,onClick,title)=>c('button',{type:'button',onClick,title,'aria-pressed':active,className:'rounded-full border px-2.5 py-1 text-xs '+(active?'border-indigo-400 bg-indigo-950 text-indigo-100':'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200')},label);
    return c('div',{className:'flex h-[100dvh] min-w-0 flex-col overflow-hidden'},
      c('header',{className:'flex min-h-14 shrink-0 flex-wrap items-center gap-3 border-b border-slate-800 bg-slate-950 px-4 py-2'},
        c('div',{className:'min-w-0 flex-1'},c('h1',{className:'truncate text-base font-bold text-white'},'Timeline · every server, one clock'),c('p',{id:'timeline-status',role:'status',className:'truncate text-xs text-slate-400'},state)),
        c('label',{className:'flex items-center gap-2 text-xs text-slate-300'},c('input',{type:'checkbox',checked:live,onChange:e=>setLive(e.target.checked)}),'Live'),
        c('button',{type:'button',onClick:load,disabled:busy,className:'rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50'},'Refresh'),
        c('a',{href:'./simple.html',className:'rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800'},'Rooms'),
        c('a',{href:'./panel.html',className:'rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800'},'Dashboard')),
      c(SystemStrip,{system,live,liveState,now}),
      c('div',{className:'flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/60 px-4 py-2'},
        c('select',{value:window_,onChange:e=>setWindow(e.target.value),'aria-label':'Time window',className:'rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200'},...M.WINDOWS.map(([name])=>c('option',{key:name,value:name},name==='all'?'all time':'last '+name))),
        ...['message','thread','import'].map(kind=>chip(kinds.includes(kind),kind,()=>toggleKind(kind),'Toggle '+kind+' events')),
        c('input',{value:q,onChange:e=>setQ(e.target.value),placeholder:'Search text or author',className:'min-w-[180px] flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-white placeholder:text-slate-500'})),
      visibleGuilds.length?c('div',{className:'scrollbar flex shrink-0 flex-wrap items-center gap-1.5 border-b border-slate-800 px-4 py-2','aria-label':'Servers'},
        chip(!guilds,'all servers',()=>setGuilds(null),'Every server that is not hidden in the sidebar'),
        ...visibleGuilds.map(g=>chip(selected.includes(g.id),g.name,()=>toggleGuild(g.id),g.imported_count+' messages'))):null,
      c('main',{className:'scrollbar min-h-0 flex-1 overflow-y-auto'},
        groups.length?groups.map(group=>c('section',{key:group.day},
          c('div',{className:'sticky top-0 z-10 flex items-center gap-3 bg-[#0b1020] px-4 py-2'},c('span',{className:'h-px flex-1 bg-slate-800'}),c('h2',{className:'text-xs font-semibold text-slate-400'},T?.dayLabel(group.day)||group.day),c('span',{className:'text-[10px] text-slate-600'},group.events.length),c('span',{className:'h-px flex-1 bg-slate-800'})),
          group.events.map(event=>c(Row,{key:event.key,event,now,expanded:!!expanded[event.key],toggle:()=>setExpanded(prev=>({...prev,[event.key]:!prev[event.key]}))}))))
        :c('div',{className:'mx-auto mt-20 max-w-md text-center'},c('h2',{className:'text-lg font-bold text-white'},busy?'Loading…':'Nothing in this window'),c('p',{className:'mt-2 text-sm leading-6 text-slate-400'},'Widen the time window, add servers, or clear the search. Live updates will appear here as they arrive.')),
        hasMore?c('div',{className:'p-4 text-center'},c('button',{type:'button',onClick:older,disabled:busy,className:'rounded-md bg-slate-800 px-4 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50'},'Older messages')):null));
  }
  RD.createRoot(root).render(c(App));
})();
