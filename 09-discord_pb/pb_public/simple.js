(function () {
  const R=window.React, RD=window.ReactDOM, h=R&&R.createElement, root=document.getElementById('simple-root');
  const KEY='__dc_superuser_auth__';
  if(!R||!RD||!h){root.textContent='Unable to load the room viewer. Check the network connection and reload.';return;}
  const {useEffect,useMemo,useRef,useState}=R;
  const params=new URLSearchParams(location.search);
  const focusQuery=params.get('guild')||'';
  const focusOnly=focusQuery&&params.get('all')!=='1';
  async function rawApi(path,options={}){const response=await fetch('./'+path,{cache:'no-store',...options});const body=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error(body.error||body.message||`Request failed (${response.status})`),{body,status:response.status});return body;}
  async function signIn(){try{const fresh=await rawApi('api/discord/admin-token',{method:'POST'});localStorage.setItem(KEY,JSON.stringify(fresh));return fresh.token;}catch(error){const saved=JSON.parse(localStorage.getItem(KEY)||'{}');if(!saved.token)throw error;const fresh=await rawApi('api/collections/_superusers/auth-refresh',{method:'POST',headers:{Authorization:saved.token}});localStorage.setItem(KEY,JSON.stringify(fresh));return fresh.token;}}
  // Superuser tokens live 300 s (050_bootstrap). Every authenticated call reads
  // the current token, and a 401 signs in again once and retries, so a room
  // opened after six minutes still loads instead of showing an auth error.
  const tokenRef={current:''};
  async function api(path,options={}){const send=()=>rawApi(path,{...options,headers:{...(options.headers||{}),...(tokenRef.current?{Authorization:tokenRef.current}:{})}});try{return await send();}catch(error){if(error.status!==401||!tokenRef.current)throw error;tokenRef.current=await signIn();return await send();}}
  // When this page is embedded in a Home Assistant dashboard (iframe strategy),
  // keep the ingress session alive the same way the HA ingress panel does. Any
  // failure (not embedded, cross-origin, no hass) is silent: the page still works.
  function keepIngressAlive(){
    try{
      if(window.parent===window)return()=>{};
      const hass=()=>window.parent.document.querySelector('home-assistant')?.hass;
      if(!hass())return()=>{};
      const session=()=>(document.cookie.match(/(?:^|; )ingress_session=([^;]+)/)||[])[1];
      const tick=async()=>{const s=session();if(!s)return;try{await hass().callWS({type:'supervisor/api',endpoint:'/ingress/validate_session',method:'post',data:{session:s}});}catch(_){}};
      const timer=setInterval(tick,60000);tick();
      return()=>clearInterval(timer);
    }catch(_){return()=>{};}
  }
  const c=(tag,props,...children)=>h(tag,props,...children);
  const time=(ts)=>window.DCTime?.absolute(ts)||ts||'Unknown time'; const relative=(ts,now)=>window.DCTime?.relative(ts,now)||''; const day=(ts)=>window.DCTime?.bangkokDay(ts)||String(ts||'').slice(0,10); const label=(date)=>window.DCTime?.dayLabel(date)||date;
  const initials=(name)=>String(name||'?').replace(/[^\p{L}\p{N} ]/gu,'').trim().split(/\s+/).slice(0,2).map(w=>w[0]).join('').toUpperCase()||'?';
  const btn='rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-slate-700 hover:text-white';

  function RoomRow({room,depth,active,choose,guild}) {
    const isActive=active?.id===room.id, muted=room.importable===false;
    return c('div',{key:room.id},
      c('button',{type:'button','data-entity-id':room.id,disabled:muted,title:muted?room.name+' · not importable (voice/forum container)':room.name+' · '+room.id,onClick:()=>choose(room,guild),
        className:'flex w-full items-center gap-1 py-1.5 pr-3 text-left text-sm '+(depth?'pl-8':'px-3')+' '+(isActive?'bg-slate-700 font-semibold text-white':muted?'text-slate-600 cursor-default':'text-slate-300 hover:bg-slate-700')},
        c('span',{className:'w-5 text-center text-slate-500'},room.icon||'#'),
        c('span',{className:'min-w-0 flex-1 truncate'},room.name),
        room.selected?c('span',{title:'Polled for import',className:'text-[10px] text-emerald-400'},'●'):null,
        room.imported_count?c('span',{className:'text-[10px] tabular-nums text-slate-500'},room.imported_count):null),
      (room.threads||[]).map(thread=>c(RoomRow,{key:thread.id,room:thread,depth:1,active,choose,guild})));
  }
  function Category({category,guild,active,choose,toggle}) {
    if(!category.id) return category.channels.map(room=>c(RoomRow,{key:room.id,room,depth:0,active,choose,guild}));
    return c('div',{key:category.id,className:'mt-3'},
      c('button',{type:'button','aria-expanded':!category.collapsed,onClick:()=>toggle(category),className:'flex w-full items-center gap-1 px-3 py-1 text-left text-[11px] font-bold uppercase tracking-wide text-slate-400 hover:text-slate-200'},
        c('span',{className:'w-3 text-[9px]'},category.collapsed?'▶':'▼'),c('span',{className:'truncate'},category.name),c('span',{className:'ml-auto text-[10px] font-normal normal-case tracking-normal text-slate-600'},category.channels.length)),
      category.collapsed?null:category.channels.map(room=>c(RoomRow,{key:room.id,room,depth:0,active,choose,guild})));
  }
  function GuildSection({guild,active,choose,setOpen,setHidden,toggleCategory,focused}) {
    const open=focused||guild.open;
    return c('section',{key:guild.id,id:'guild-'+guild.id,'data-guild-id':guild.id,className:'mb-2 border-b border-slate-700/60 pb-2'},
      c('div',{className:'flex items-center gap-1 px-2'},
        c('button',{type:'button','aria-expanded':open,title:(open?'Close ':'Open ')+guild.name,onClick:()=>setOpen(guild,!open),className:'flex min-w-0 flex-1 items-center gap-2 py-2 text-left'},
          c('span',{className:'w-3 text-[9px] text-slate-400'},open?'▼':'▶'),
          c('span',{className:'grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-slate-700 text-[10px] font-bold text-slate-200'},initials(guild.name)),
          c('span',{className:'min-w-0 flex-1 truncate text-sm font-bold text-white'},guild.name),
          c('span',{className:'text-[10px] tabular-nums text-slate-500',title:guild.channel_count+' rooms · '+(guild.imported_count||0)+' messages'},guild.imported_count||0)),
        c('button',{type:'button',title:'Hide '+guild.name+' from the sidebar','aria-label':'Hide '+guild.name,onClick:()=>setHidden(guild,true),className:btn},'⊘')),
      open?(guild.categories.length?guild.categories.map(category=>c(Category,{key:category.id||'root',category,guild,active,choose,toggle:toggleCategory}))
        :c('p',{className:'px-4 py-2 text-xs text-slate-500'},'No rooms discovered yet.')):null);
  }
  function HiddenServers({guilds,setHidden}) {
    if(!guilds.length)return null;
    return c('details',{className:'border-t border-slate-700 px-3 py-2'},
      c('summary',{className:'cursor-pointer text-xs font-semibold text-slate-400'},`Hidden servers (${guilds.length})`),
      guilds.map(guild=>c('div',{key:guild.id,className:'flex items-center gap-2 py-1 text-sm text-slate-400'},
        c('span',{className:'min-w-0 flex-1 truncate'},guild.name),
        c('button',{type:'button',onClick:()=>setHidden(guild,false),className:btn+' text-emerald-300'},'Show'))));
  }
  function RoomTree({guilds,active,query,setQuery,choose,setOpen,setHidden,toggleCategory,focus,clearFocus,status}) {
    const visible=guilds.filter(g=>!g.hidden&&(!focus||g.id===focus.id));
    const q=query.trim().toLowerCase();
    const filtered=q?visible.map(g=>({...g,open:true,categories:g.categories.map(cat=>({...cat,collapsed:false,channels:cat.channels.filter(room=>[room.name,...room.threads.map(t=>t.name)].join(' ').toLowerCase().includes(q))})).filter(cat=>cat.channels.length)})).filter(g=>g.categories.length):visible;
    const content=filtered.length?filtered.map(guild=>c(GuildSection,{key:guild.id,guild,active,choose,setOpen,setHidden,toggleCategory,focused:!!focus}))
      :c('p',{className:'px-4 text-sm text-slate-500'},q?'No matching rooms.':guilds.length?'Every server is hidden. Show one below.':'No servers discovered yet.');
    return c('aside',{id:'simple-tree',className:'scrollbar flex min-h-0 w-72 shrink-0 flex-col overflow-y-auto bg-nav text-slate-200'},
      c('div',{className:'border-b border-slate-700 px-4 py-3'},
        c('div',{className:'flex items-center justify-between gap-2'},c('div',{className:'text-sm font-bold text-white'},focus?focus.name:'Discord Archive'),
          focus?c('a',{href:'./simple.html?all=1',className:'text-[11px] text-indigo-300 hover:underline'},'All servers'):null),
        c('p',{id:'simple-status',role:'status',className:'mt-1 truncate text-xs text-slate-400',title:status},status)),
      c('div',{className:'px-3 py-3'},c('input',{value:query,onChange:e=>setQuery(e.target.value),placeholder:'Find a room',className:'w-full rounded-md border border-slate-600 bg-rail px-3 py-2 text-sm text-white placeholder:text-slate-500'})),
      c('nav',{className:'pb-3','aria-label':'Servers, categories, channels, and threads'},content),
      c(HiddenServers,{guilds:guilds.filter(g=>g.hidden),setHidden}));
  }
  function Rail({guilds,current,pick,openServers}) {
    const visible=guilds.filter(g=>!g.hidden), hidden=guilds.length-visible.length;
    return c('aside',{className:'scrollbar hidden w-16 shrink-0 flex-col items-center gap-2 overflow-y-auto bg-rail py-3 md:flex','aria-label':'Server rail'},
      c('a',{href:'./panel.html',title:'Archive dashboard',className:'grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent text-sm font-bold text-white'},'DA'),
      c('div',{className:'my-1 h-px w-8 bg-slate-700'}),
      ...visible.map(guild=>c('button',{key:guild.id,type:'button',onClick:()=>pick(guild),title:guild.name+' · '+(guild.imported_count||0)+' messages','aria-label':guild.name,'aria-current':current===guild.id?'true':undefined,
        className:'relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xs font-bold '+(current===guild.id?'bg-accent text-white':'bg-slate-700 text-slate-200 hover:bg-slate-600')},
        initials(guild.name),
        guild.open?null:c('span',{className:'absolute -right-1 -top-1 h-2 w-2 rounded-full bg-slate-500',title:'closed'}))),
      c('button',{type:'button',onClick:openServers,title:'Servers: choose which to open or hide','aria-label':'Manage servers',className:'mt-auto grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-800 text-lg text-slate-300 hover:bg-slate-700'},hidden?c('span',{className:'text-xs'},'+'+hidden):'⚙'));
  }
  function ServersDialog({guilds,close,setOpen,setHidden,order}) {
    return c('div',{className:'fixed inset-0 z-40 grid place-items-center bg-black/70 p-4',onClick:close,role:'dialog','aria-modal':'true','aria-label':'Servers'},
      c('div',{className:'w-full max-w-lg rounded-xl bg-nav p-5 text-slate-200 shadow-xl',onClick:e=>e.stopPropagation()},
        c('div',{className:'flex items-center justify-between'},c('h2',{className:'text-base font-bold text-white'},'Servers'),c('button',{type:'button',onClick:close,className:btn},'Close')),
        c('p',{className:'mt-1 text-xs text-slate-400'},'Built from the archive, server by server. Open shows the rooms; Sidebar keeps the server in the rail. Choices are saved on the box.'),
        c('table',{className:'mt-4 w-full text-left text-sm'},
          c('thead',null,c('tr',{className:'text-[11px] uppercase tracking-wide text-slate-500'},c('th',{className:'py-1'},'Server'),c('th',{className:'py-1 text-right'},'Rooms'),c('th',{className:'py-1 text-right'},'Messages'),c('th',{className:'py-1 text-center'},'Open'),c('th',{className:'py-1 text-center'},'Sidebar'),c('th',{className:'py-1 text-center'},'Order'))),
          c('tbody',null,guilds.map((guild,index)=>c('tr',{key:guild.id,className:'border-t border-slate-700/70'},
            c('td',{className:'max-w-[200px] truncate py-2',title:guild.name+' · '+guild.id},guild.name),
            c('td',{className:'py-2 text-right tabular-nums text-slate-400'},guild.channel_count),
            c('td',{className:'py-2 text-right tabular-nums text-slate-400'},guild.imported_count||0),
            c('td',{className:'py-2 text-center'},c('input',{type:'checkbox','aria-label':'Open '+guild.name,checked:!!guild.open,disabled:guild.hidden,onChange:e=>setOpen(guild,e.target.checked)})),
            c('td',{className:'py-2 text-center'},c('input',{type:'checkbox','aria-label':'Show '+guild.name+' in sidebar',checked:!guild.hidden,onChange:e=>setHidden(guild,!e.target.checked)})),
            c('td',{className:'py-2 text-center whitespace-nowrap'},c('button',{type:'button','aria-label':'Move '+guild.name+' up',disabled:index===0,onClick:()=>order(guild,-1),className:btn},'↑'),c('button',{type:'button','aria-label':'Move '+guild.name+' down',disabled:index===guilds.length-1,onClick:()=>order(guild,1),className:btn},'↓')))))),
        c('p',{className:'mt-3 text-[11px] text-slate-500'},'Pin a server to the Home Assistant sidebar with: just sidebar-pin <server id>  — or sync every open server: just sidebar-sync')));
  }
  function Feed({messages,active,state,now}) {
    const groups=useMemo(()=>messages.reduce((out,message)=>{const key=day(message.ts);(out[key]||=[]).push(message);return out;},{}),[messages]);
    if(!Object.keys(groups).length)return c('div',{className:'mx-auto mt-20 max-w-md text-center'},c('p',{className:'text-sm text-slate-400',role:'status'},state),c('h2',{className:'mt-3 text-lg font-bold text-white'},active?'No imported messages in this room':'Your servers will appear here'),c('p',{className:'mt-2 text-sm leading-6 text-slate-400'},active?'Choose a polled room (●) or use the dashboard to backfill this one.':'The sidebar is loading from PocketBase.'));
    return c('div',null,c('p',{className:'mb-5 text-sm text-slate-400',role:'status'},state),Object.entries(groups).map(([date,items])=>c('section',{key:date},c('div',{className:'sticky top-0 z-10 my-5 flex items-center gap-3 bg-slate-950 py-2'},c('span',{className:'h-px flex-1 bg-slate-800'}),c('h2',{className:'text-xs font-semibold text-slate-400'},label(date)),c('span',{className:'h-px flex-1 bg-slate-800'})),items.map(message=>c('article',{key:message.id||message.message_id,className:'flex gap-3 py-2'},c('div',{className:'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-slate-700 text-xs font-bold text-slate-200'},(message.author_name||'?').slice(0,2).toUpperCase()),c('div',{className:'min-w-0'},c('div',{className:'flex flex-wrap items-baseline gap-x-2'},c('strong',{className:'text-sm text-slate-100'},message.author_name||message.author_id||'Unknown'),c('time',{title:window.DCTime?.iso(message.ts)||message.ts,className:'text-xs text-slate-500'},time(message.ts)),c('span',{className:'text-xs text-slate-600'},relative(message.ts,now))),c('p',{className:'whitespace-pre-wrap break-words text-sm leading-6 text-slate-300'},message.content||'[no text]')))))));
  }
  function App(){
    const [token,setToken]=useState(''),[data,setData]=useState(null),[active,setActive]=useState(null),[messages,setMessages]=useState([]),[state,setState]=useState('Connecting through Home Assistant…'),[query,setQuery]=useState(''),[drawer,setDrawer]=useState(false),[servers,setServers]=useState(false),[now,setNow]=useState(Date.now()),[saveState,setSaveState]=useState('');
    useEffect(()=>{const interval=setInterval(()=>setNow(Date.now()),30000);const stop=keepIngressAlive();return()=>{clearInterval(interval);stop();};},[]);
    // Re-sign every 60 s while the tab is visible so the 300 s token never lapses mid-read.
    useEffect(()=>{if(!token)return;const refresh=setInterval(async()=>{if(document.hidden)return;try{tokenRef.current=await signIn();}catch(_){}},60000);return()=>clearInterval(refresh);},[token]);
    const guilds=useMemo(()=>data?window.DCSimpleTree.buildSidebar(data):[],[data]);
    const focus=useMemo(()=>focusOnly?window.DCSimpleTree.findGuild(guilds,focusQuery):null,[guilds]);
    useEffect(()=>{(async()=>{try{const fresh=await signIn();tokenRef.current=fresh;setToken(fresh);const payload=await api('api/dc/sidebar');setData(payload);
      const built=window.DCSimpleTree.buildSidebar(payload);const start=window.DCSimpleTree.findGuild(built,focusQuery)||built.find(g=>!g.hidden&&g.open)||built.find(g=>!g.hidden)||built[0];
      const first=start&&window.DCSimpleTree.firstRoom(start);if(first)setActive({id:first.id,name:first.name,kind:first.kind,guild:start.name,guild_id:start.id});
      const visible=built.filter(g=>!g.hidden).length;setState(`${visible} of ${built.length} servers · ${payload.channels.length} rooms`+(payload.model_error?' · model invalid':''));}
      catch(error){setState(error.body?.haUser?`Home Assistant user ${error.body.haUser.id||''} is not allowed: ${error.message}`:error.message);}})();},[]);
    useEffect(()=>{if(!token||!active)return;let dead=false;(async()=>{try{setState(`Loading #${active.name}…`);const filter=active.kind==='thread'?`thread_id=${JSON.stringify(active.id)}`:`channel_id=${JSON.stringify(active.id)} && (thread_id='' || thread_id=null)`;const result=await api('api/collections/discord_messages/records?'+new URLSearchParams({page:'1',perPage:'100',sort:'-ts,-message_id',filter}));if(!dead){setMessages(result.items||[]);setState(`${result.totalItems||0} messages in #${active.name}`);}}catch(error){if(!dead)setState(error.message);}})();return()=>{dead=true};},[token,active]);
    // Optimistic preference writes: the tree updates at once; the server answer
    // replaces it, and a refusal restores the snapshot taken before the click.
    const savePrefs=async(patch,next)=>{let snapshot=null;setData(prev=>{snapshot=prev.prefs;return{...prev,prefs:next(prev.prefs)};});setSaveState('saving');try{const result=await api('api/dc/sidebar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});setData(prev=>({...prev,prefs:result.prefs}));setSaveState('');}catch(error){setData(prev=>({...prev,prefs:snapshot||prev.prefs}));setSaveState('not saved: '+error.message);}};
    const setOpen=(guild,open)=>savePrefs({open:{[guild.id]:open}},prefs=>({...prefs,open:{...prefs.open,[guild.id]:open}}));
    const setHidden=(guild,hidden)=>savePrefs(hidden?{hide:[guild.id]}:{show:[guild.id]},prefs=>({...prefs,hidden:hidden?[...prefs.hidden.filter(id=>id!==guild.id),guild.id]:prefs.hidden.filter(id=>id!==guild.id)}));
    const toggleCategory=(category)=>savePrefs({collapsed:{[category.id]:!category.collapsed}},prefs=>({...prefs,collapsed:{...prefs.collapsed,[category.id]:!category.collapsed}}));
    const order=(guild,delta)=>{const ids=guilds.map(g=>g.id);const index=ids.indexOf(guild.id),target=index+delta;if(target<0||target>=ids.length)return;ids.splice(index,1);ids.splice(target,0,guild.id);savePrefs({order:ids},prefs=>({...prefs,order:ids}));};
    // The guild object travels with the click: names can repeat, ids cannot.
    const choose=(node,guild)=>{setActive({id:node.id,name:node.name,kind:node.kind,guild:guild.name,guild_id:guild.id});setDrawer(false);};
    const pick=(guild)=>{if(!guild.open)setOpen(guild,true);const first=window.DCSimpleTree.firstRoom(guild);if(first)setActive({id:first.id,name:first.name,kind:first.kind,guild:guild.name,guild_id:guild.id});requestAnimationFrame(()=>document.getElementById('guild-'+guild.id)?.scrollIntoView({block:'start',behavior:'smooth'}));};
    const navigation=c(RoomTree,{guilds,active,query,setQuery,choose,setOpen,setHidden,toggleCategory,focus,status:saveState||state});
    return c('div',{className:'flex h-[100dvh] min-w-0 overflow-hidden bg-ink'},
      c(Rail,{guilds,current:active?.guild_id,pick,openServers:()=>setServers(true)}),
      c('div',{className:'hidden min-h-0 md:flex'},navigation),
      drawer?c('div',{className:'fixed inset-0 z-30 bg-black/60 md:hidden',onClick:()=>setDrawer(false)},c('div',{className:'h-full w-80 max-w-[85vw]',onClick:event=>event.stopPropagation()},navigation)):null,
      servers?c(ServersDialog,{guilds,close:()=>setServers(false),setOpen,setHidden,order}):null,
      c('main',{id:'simple-room',className:'flex min-w-0 flex-1 flex-col bg-slate-950'},
        c('header',{className:'flex min-h-16 shrink-0 items-center gap-3 border-b border-slate-800 px-4'},
          c('button',{type:'button',onClick:()=>setDrawer(true),className:'rounded-md p-2 text-slate-300 hover:bg-slate-800 md:hidden','aria-label':'Open server list'},'☰'),
          c('div',{className:'min-w-0 flex-1'},c('h1',{className:'truncate text-base font-bold text-white'},active?`${active.kind==='thread'?'↳':'#'} ${active.name}`:'Choose a room'),c('p',{className:'truncate text-xs text-slate-400'},active?`${active.guild} · ${active.id}`:'Server → category → channel → thread')),
          c('button',{type:'button',onClick:()=>setServers(true),className:'hidden rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 sm:block'},'Servers'),
          c('a',{href:'./panel.html',className:'hidden rounded-md px-3 py-2 text-sm text-slate-300 hover:bg-slate-800 sm:block'},'Dashboard'),
          c('a',{href:'./_/',className:'rounded-md bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110'},'Admin')),
        c('div',{className:'scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-7'},c(Feed,{messages,active,state,now}))));
  }
  RD.createRoot(root).render(c(App));
})();
