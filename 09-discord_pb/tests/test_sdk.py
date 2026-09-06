import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("bun"), "Bun is required for SDK tests")
class SDKTests(unittest.TestCase):
    def test_bun_sdk_and_cli(self):
        result = subprocess.run(
            ["bun", "test", "sdk/dc.test.ts"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_jsvm_commonjs_build_has_sync_transport(self):
        script = """
const fs=require('node:fs'),vm=require('node:vm');
const module={exports:{}};
const context={module,exports:module.exports,encodeURIComponent,JSON,Object,String,Error,Array};
if(vm.runInNewContext("typeof fetch !== 'undefined' || typeof URLSearchParams !== 'undefined'",context))process.exit(1);
vm.runInNewContext(fs.readFileSync('./pb_hooks/lib/dc.js','utf8'),context);
const {createDC}=module.exports;
const seen=[];
const dc=createDC({baseUrl:'http://pb/',token:'session',transport:r=>{seen.push(r);return {messages:[{id:'1'}]}}});
const rows=dc.channel('name with space').read({limit:2});
const allowed=createDC({baseUrl:'http://pb',token:'session',transport:r=>({allowed:true})}).channel('name').allowed('post');
if(rows[0].id!=='1'||allowed!==true||!seen[0].url.includes('name%20with%20space')||seen[0].headers.Authorization!=='session')process.exit(1);
"""
        result = subprocess.run(
            ["node", "-e", script], cwd=ROOT, text=True, capture_output=True, timeout=10
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_committed_jsvm_build_matches_source(self):
        result = subprocess.run(
            ["bash", "-c", "tmp=$(mktemp); bun build --target=browser --format=cjs sdk/dc.ts --outfile=$tmp >/dev/null && cmp -s $tmp pb_hooks/lib/dc.js"],
            cwd=ROOT, text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
