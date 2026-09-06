"""Lock the live/REST field contract, including Goja's distinct JSONRaw handling."""
import json
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
from backfill import normalize


class NormalizeParityTests(unittest.TestCase):
    def test_live_and_rest_normalizers_have_identical_field_mapping(self):
        message = {'id':'900000000900000001','author':{'id':'900000000000000003',
            'username':'fallback','global_name':'Oracle ไทย','bot':True},'content':'',
            'timestamp':'2026-09-06T00:00:00Z','edited_timestamp':None,
            'attachments':[{'id':'attachment'}],'embeds':[{'title':'preserve'}],
            'message_reference':{'message_id':'900000000900000000'}}
        context = {'channel_id':'900000000000000000','thread_id':'900000000000000001',
                   'guild_id':'900000000000000002'}
        script = "const i=require('./pb_hooks/lib/discord_ingest.js');let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify(i.normalizeDispatch(x.message,x.context,null,'MESSAGE_CREATE','2026-09-06T01:00:00Z')))});"
        result = subprocess.run(['node','-e',script],input=json.dumps({'message':message,'context':context}),
            capture_output=True,text=True,cwd=ROOT,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        live = json.loads(result.stdout)
        live['raw'].pop('_discord_pb_live_at')
        self.assertEqual(live,normalize(message,context))
