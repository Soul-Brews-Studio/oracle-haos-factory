import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dashboardHtml, escapeHtml, parseExtra, summarize, unsupportedNamedRoom } from "./dropbox-extras";

const cleanup: string[] = [];
afterEach(() => { while (cleanup.length) rmSync(cleanup.pop()!, { recursive: true, force: true }); });
function temp(prefix: string) { const path=mkdtempSync(join(tmpdir(),prefix)); cleanup.push(path); return path; }

describe("statistics", () => {
  test("summarizes validated listings", () => {
    const result=summarize({ files:[
      {name:"one",size:1048576,sender:"alice",modified:"2026-09-06T00:00:00Z"},
      {name:"two",size:524288,sender:"bob",modified:"bad"},
    ],senders:["alice","carol",""] },new Date("2026-09-06T01:02:03Z"));
    expect(result.stats).toEqual({checked_at:"2026-09-06T01:02:03.000Z",files:2,bytes:1572864,mib:1.5,named_senders:3,latest:"2026-09-06T00:00:00.000Z"});
  });
  test("accepts an empty listing", () => expect(summarize({files:[]}).stats.files).toBe(0));
  test.each([
    null, {}, {files:{}}, {files:[{name:1,size:1}]}, {files:[{name:"x",size:-1}]},
    {files:[{name:"x",size:1.5}]}, {files:[{name:"x",size:Number.MAX_SAFE_INTEGER},{name:"y",size:1}]},
  ])("rejects malformed or unsafe data", value => expect(() => summarize(value)).toThrow());
});

describe("output safety", () => {
  test("escapes all HTML metacharacters", () => expect(escapeHtml(`<img src=x onerror='x'>&\"`)).toBe("&lt;img src=x onerror=&#39;x&#39;&gt;&amp;&quot;"));
  test("escapes listing metadata and rejects credential-bearing dashboard URLs", () => {
    const html=dashboardHtml({checked_at:"now",files:1,bytes:1,mib:0,named_senders:1,latest:null},[{name:"<script>alert(1)</script>",size:1,sender:'\" onclick=\"x'}],"http://kvmlab1.oracle.netbird/hassio/ingress/local_p2p_dropbox");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(() => dashboardHtml({checked_at:"",files:0,bytes:0,mib:0,named_senders:0,latest:null},[],"http://key@host/path")).toThrow("Unsafe dashboard URL");
  });
});

describe("command grammar and rooms", () => {
  test("parses extras and rejects stray options", () => {
    expect(parseExtra(["stats","--json"])).toEqual({command:"stats",json:true,open:false});
    expect(parseExtra(["send","x"])).toBeNull();
    expect(() => parseExtra(["share","--open"])).toThrow("Usage");
  });
  test("blocks named-room delegation only where old transport would lie", () => {
    expect(unsupportedNamedRoom(["send","a"],{ROOM:"private"})).toBe("private");
    expect(unsupportedNamedRoom(["status"],{ROOM:" private "})).toBe("private");
    expect(unsupportedNamedRoom(["send","a"],{ROOM:"default"})).toBeNull();
    expect(unsupportedNamedRoom(["ls"],{ROOM:"private"})).toBeNull();
  });
});

describe("decorator integration", () => {
  async function staged(key = "test-secret-never-print") {
    const dir=temp("maw-dropbox-extras-");
    cpSync(join(import.meta.dir,"dropbox-extras.ts"),join(dir,"dropbox-extras.ts"));
    writeFileSync(join(dir,"index.ts"),`export async function main(argv:string[],log:(s:string)=>void){log("base:"+argv.join(" "));return 7}\n`);
    writeFileSync(join(dir,"config.ts"),`
export async function resolveConfig(){return {auth_key:${JSON.stringify(key)},http_url:"http://example.invalid",ingress_url:"http://kvmlab1.oracle.netbird/hassio/ingress/local_p2p_dropbox",signal_url:"ws://example.invalid/ws",peer:"p2p-dropbox"}}
export function redact(text:string,key:string){return text.split(key).join("[REDACTED]")}
`);
    return await import(`${new URL(`file://${join(dir,"dropbox-extras.ts")}`).href}?test=${crypto.randomUUID()}`);
  }
  test("delegates old commands and refuses named-room sends before transport", async () => {
    const mod=await staged(), logs:string[]=[];
    expect(await mod.main(["ls"],(s:string)=>logs.push(s))).toBe(7);
    expect(logs).toEqual(["base:ls"]);
    const previous=process.env.ROOM;process.env.ROOM="secret-room";
    try {
      logs.length=0;expect(await mod.main(["send","file"],(s:string)=>logs.push(s))).toBe(1);
      expect(logs.join("\n")).toContain("does not support ROOM");
    } finally { if(previous===undefined)delete process.env.ROOM;else process.env.ROOM=previous; }
  });
  test("dashboard supports punctuation-only keys without corrupting JSON", async () => {
    const mod=await staged('"'), originalFetch=globalThis.fetch, logs:string[]=[];
    globalThis.fetch=Object.assign(async () => Response.json({files:[{name:'file"name.txt',size:1}]}), {preconnect:originalFetch.preconnect});
    try {
      expect(await mod.main(["dashboard"],(s:string)=>logs.push(s))).toBe(0);
      const path=logs.at(-1)!;cleanup.push(join(path,".."));
      expect(readFileSync(path,"utf8")).toContain("file[REDACTED]name.txt");
    } finally { globalThis.fetch=originalFetch; }
  });
  test("renders authenticated stats and a secret-free escaped dashboard", async () => {
    const mod=await staged(), originalFetch=globalThis.fetch, logs:string[]=[];
    globalThis.fetch=(async (_input:RequestInfo|URL, init?:RequestInit) => {
      expect((init?.headers as Record<string,string>).Authorization).toBe("Bearer test-secret-never-print");
      return Response.json({files:[{name:"<script>test-secret-never-print</script>",size:8,sender:"alice"}]});
    }) as typeof fetch;
    try {
      expect(await mod.main(["stats","--json"],(s:string)=>logs.push(s))).toBe(0);
      expect(JSON.parse(logs.pop()!).files).toBe(1);
      expect(await mod.main(["share"],(s:string)=>logs.push(s))).toBe(0);
      expect(logs.at(-1)).toContain("NetBird VPN required");
      expect(logs.at(-1)).not.toContain("test-secret-never-print");
      expect(await mod.main(["dashboard"],(s:string)=>logs.push(s))).toBe(0);
      const path=logs.at(-1)!;cleanup.push(join(path,".."));
      const html=readFileSync(path,"utf8");
      expect(html).not.toContain("test-secret-never-print");
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;[REDACTED]&lt;/script&gt;");
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    } finally { globalThis.fetch=originalFetch; }
  });
});

describe("installer", () => {
  const installer=join(import.meta.dir,"install-extras.ts");
  async function run(dir:string,...args:string[]) {
    const child=Bun.spawn([process.execPath,installer,...args,dir],{stdout:"pipe",stderr:"pipe",env:{...process.env}});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {stdout,stderr,code};
  }
  function fixture() {
    const dir=temp("maw-dropbox-plugin-");
    const manifest={name:"dropbox",version:"1.1.0",entry:"./index.ts",runtime:"bun-dev",description:"keep me",capabilities:["net:http"]};
    writeFileSync(join(dir,"plugin.json"),JSON.stringify(manifest,null,2)+"\n");
    writeFileSync(join(dir,"index.ts"),"export const untouched=true;\n");
    writeFileSync(join(dir,"config.ts"),"export const untouched=true;\n");
    mkdirSync(join(dir,"dist"));writeFileSync(join(dir,"dist/transport.js"),"// transport\n");
    writeFileSync(join(dir,"user-config.txt"),"must survive\n");
    return {dir,manifest};
  }
  test("installs and removes without changing unrelated files or manifest fields", async () => {
    const {dir,manifest}=fixture();
    expect((await run(dir)).code).toBe(0);
    const installed=JSON.parse(readFileSync(join(dir,"plugin.json"),"utf8"));
    expect(installed).toEqual({...manifest,entry:"./dropbox-extras.ts"});
    expect(lstatSync(join(dir,"dropbox-extras.ts")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir,"user-config.txt"),"utf8")).toBe("must survive\n");
    expect((await run(dir,"--remove")).code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir,"plugin.json"),"utf8"))).toEqual(manifest);
    expect(readFileSync(join(dir,"user-config.txt"),"utf8")).toBe("must survive\n");
  });
  test("refuses another wrapper and symlinked plugin directories", async () => {
    const {dir}=fixture();
    const manifest=JSON.parse(readFileSync(join(dir,"plugin.json"),"utf8"));manifest.entry="./someone-else.ts";
    writeFileSync(join(dir,"plugin.json"),JSON.stringify(manifest));
    expect((await run(dir)).code).not.toBe(0);
    const parent=temp("maw-dropbox-link-");
    const link=join(parent,"dropbox");await Bun.$`ln -s ${dir} ${link}`.quiet();
    expect((await run(link)).code).not.toBe(0);
  });
});
