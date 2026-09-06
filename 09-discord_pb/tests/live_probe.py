#!/usr/bin/env python3
"""Token-free fake Gateway -> actual PB -> actual authenticated SSE container proof."""
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
from urllib.request import Request, urlopen

sys.path.insert(0, '/app')
sys.path.insert(0, str(Path(__file__).parent))
import backfill
import gateway
from fake_gateway import FakeGateway, hello, receive_until, send_json, send_frame
from dc_probe import request, auth, wait_idle, CONFIG, file_snapshot, restore_file, OPTIONS

C, T, G = '900000000000000000', '900000000000000001', '900000000000000002'
M, ORPHAN, IGNORED = '900000000900000001', '900000000900000002', '900000000900000003'
A = '900000000000000003'


def main():
    options = json.loads(OPTIONS.read_text()); token = auth(options)
    wait_idle(token)
    assert request('/api/dc/status')[0] == 401
    status, initial = request('/api/dc/status', token=token)
    assert status == 200 and initial['live_status']['enabled'] is False, initial
    assert initial['live_status']['error'] == 'disabled', initial
    internal = Path('/run/discord-pb/internal-token').read_text().strip()
    os.environ['DISCORD_PB_INTERNAL_TOKEN'] = internal
    assert request('/api/discord/internal/live', 'POST', {'event':'MESSAGE_CREATE','data':{}})[0] == 401
    old_config = file_snapshot(CONFIG)
    state_path = Path('/data/backfill-state.json'); old_state = json.loads(state_path.read_text())
    missed = []
    events, errors = [], []
    message = {'id':M,'channel_id':C,'guild_id':G,'author':{'id':A,'username':'Gateway proof'},
        'content':'live first','timestamp':'2026-09-06T02:00:00.000Z','attachments':[],'embeds':[]}
    sse = None
    try:
        config = {'guilds':{G:{'channels':{C:{'import':True},'*':{'import':False}}}}}
        assert request('/api/dc/config/save','POST',{'config':config},token)[0] == 200
        wait_idle(token)
        sse = urlopen(Request('http://127.0.0.1:8110/api/realtime',headers={'Accept':'text/event-stream'}),timeout=20)
        def frame():
            name, payload = '', []
            while True:
                line=sse.readline().decode().rstrip('\r\n')
                if not line and payload: return name,json.loads('\n'.join(payload))
                if line.startswith('event:'): name=line[6:].strip()
                elif line.startswith('data:'): payload.append(line[5:].lstrip())
        name, connect = frame(); assert name == 'PB_CONNECT'
        assert request('/api/realtime','POST',{'clientId':connect['clientId'],'subscriptions':['discord_messages/*']},token)[0] == 204
        def collect():
            try:
                while True:
                    name, item = frame()
                    if name != 'discord_messages/*': continue
                    if item['record']['message_id'] in (M,ORPHAN): events.append(item)
                    if item['record']['message_id'] == ORPHAN and item['record']['raw'].get('_discord_pb_deleted'): return
            except BaseException as error: errors.append(type(error).__name__)
        consumer = threading.Thread(target=collect,daemon=True);consumer.start()
        def ack_through(fixture, stream, seq):
            for _ in range(100):
                heartbeat=receive_until(stream,1,fixture,timeout=5)
                if heartbeat['d'] is not None and heartbeat['d'] >= seq: return
            raise AssertionError('Gateway dispatches not accepted')
        def first(fixture, stream):
            hello(stream,100); identify=receive_until(stream,2,fixture)
            assert identify['d']['token']=='' and identify['d']['intents']==33281
            send_json(stream,{'op':0,'s':1,'t':'READY','d':{'session_id':'local-live-proof','resume_gateway_url':fixture.ws_url}})
            send_json(stream,{'op':0,'s':2,'t':'MESSAGE_CREATE','d':message})
            send_json(stream,{'op':0,'s':3,'t':'MESSAGE_CREATE','d':dict(message,id=IGNORED,channel_id=T)})
            send_json(stream,{'op':0,'s':4,'t':'MESSAGE_UPDATE','d':{'id':M,'channel_id':C,'content':'live edit','edited_timestamp':'2026-09-06T02:01:00Z'}})
            ack_through(fixture,stream,4)
            # A message exists in Discord REST but no Gateway dispatch is sent.
            # Disconnect must wake the real poller and fill this actual gap.
            req=Request('http://fixture:18080/channels/'+C+'/messages',method='POST',
                data=json.dumps({'content':'missed while offline'}).encode(),headers={'Content-Type':'application/json'})
            with urlopen(req,timeout=5) as response: missed.append(json.load(response)['id'])
            send_frame(stream,8,struct.pack('!H',4000))
        def second(fixture,stream):
            hello(stream,100); resume=receive_until(stream,6,fixture)
            assert resume['d']['session_id']=='local-live-proof' and resume['d']['seq']==4,resume
            send_json(stream,{'op':0,'s':5,'t':'RESUMED','d':{}})
            send_json(stream,{'op':0,'s':6,'t':'MESSAGE_CREATE','d':message}) # stale replay
            send_json(stream,{'op':0,'s':7,'t':'MESSAGE_DELETE','d':{'id':M,'channel_id':C}})
            send_json(stream,{'op':0,'s':8,'t':'MESSAGE_DELETE','d':{'id':ORPHAN,'channel_id':C}})
            ack_through(fixture,stream,8)
            send_frame(stream,8,struct.pack('!H',4000))
        with FakeGateway([first,second]) as fixture, tempfile.TemporaryDirectory() as folder:
            listener=gateway.GatewayListener('',gateway.gateway_api('',fixture.api_url),
                status_file=Path(folder)/'status.json',gap_file='/data/backfill-request',sleeper=lambda _:None)
            try: listener.run(max_connections=2)
            finally: listener.stop()
            assert not fixture.errors,fixture.errors
            assert listener.sequence==8,listener.sequence
            live=json.loads((Path(folder)/'status.json').read_text())
            assert live['stored']==4 and live['ignored']>=2,live
        consumer.join(timeout=10);assert not consumer.is_alive() and not errors,errors
        # Invalid external edits must never reuse the previously compiled allow set.
        current_yaml=CONFIG.read_bytes();CONFIG.write_text('guilds: [')
        rejected=backfill.pb_post('/api/discord/internal/live',{'event':'MESSAGE_CREATE','data':dict(message,id=IGNORED)})
        assert rejected['ignored']==1 and rejected['reason']=='invalid_model'
        CONFIG.write_bytes(current_yaml)
        assert any(e['action']=='create' and e['record']['message_id']==M for e in events)
        assert any(e['action']=='update' and e['record']['content']=='live edit' for e in events)
        assert any(e['record']['raw'].get('_discord_pb_deleted') for e in events)
        rows=request('/api/collections/discord_messages/records?perPage=500',token=token)[1]['items']
        by_id={r['message_id']:r for r in rows}
        assert M in by_id and ORPHAN in by_id and IGNORED not in by_id
        assert by_id[M]['content']=='live edit' and by_id[M]['author_id']==A
        assert by_id[M]['raw']['_discord_pb_deleted'] and by_id[ORPHAN]['raw']['_discord_pb_deleted']
        assert by_id[ORPHAN]['author_id']=='unknown'
        normalized=backfill.normalize(message,{'channel_id':C,'thread_id':None,'guild_id':G})
        replay=backfill.pb_post('/api/discord/internal/upsert',{'messages':[normalized]})
        assert replay['inserted']==0 and replay['updated']==1,replay
        preserved=request('/api/collections/discord_messages/records/'+by_id[M]['id'],token=token)[1]
        assert preserved['raw']['_discord_pb_deleted'] and preserved['content']=='live edit'
        wait_idle(token)
        # Gateway never writes this file; service.py's disconnect-triggered REST
        # sweep must now have persisted the missed message and advanced C only.
        assert len(missed)==1
        rows=request('/api/collections/discord_messages/records?perPage=500',token=token)[1]['items']
        assert sum(r['message_id']==missed[0] for r in rows)==1, 'poller did not fill disconnected gap'
        state=json.loads(state_path.read_text())
        assert int(state[C])==int(missed[0]) and all(state[k]==v for k,v in old_state.items() if k!=C)
        print('LIVE PROOF PASS: s6 disabled status; private auth; fake HELLO/IDENTIFY/heartbeat/READY/RESUME; model gating; partial edit; durable tombstones; REST dedupe; gap reconciliation; real authenticated PB SSE create/update',flush=True)
    finally:
        if sse: sse.close()
        # Restore REST fixture before restoring the cursor, and wait out the
        # serialized reconciliation worker before local-only file restoration.
        req=Request('http://fixture:18080/_fixture/restore-writes',method='POST',data=b'{}')
        with urlopen(req,timeout=5) as response: response.read()
        wait_idle(token)
        backfill.save_state(old_state, str(state_path))
        # Cleanup only this proof's known synthetic IDs; preserve all archive records.
        rows=request('/api/collections/discord_messages/records?perPage=500',token=token)[1].get('items',[])
        for row in rows:
            if row['message_id'] in (M,ORPHAN,IGNORED,*missed): request('/api/collections/discord_messages/records/'+row['id'],'DELETE',token=token)
        restore_file(CONFIG,old_config)


if __name__=='__main__':main()
