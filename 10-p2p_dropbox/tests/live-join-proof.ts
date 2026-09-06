/** Explicitly authorized live proof. Reads the EXISTING key on stdin; never logs it.
 * SIGNAL_URL / HTTP_URL select the target; this writes two unique fixture files there.
 * No options, credentials, other add-ons, or existing files are changed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signalingClientUrl } from "../dropbox/client-url";

const key = (await Bun.stdin.text()).trim();
if (!key) throw new Error("Existing AUTH_KEY must be supplied privately on stdin");
const signal = process.env.SIGNAL_URL || "ws://kvmlab1.oracle.netbird:3847/ws";
const base = process.env.HTTP_URL || "http://kvmlab1.oracle.netbird:3847";
const room = process.env.ROOM || "default";
const suffix = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const receiverName = `m5-join-recv-${suffix}`;
const root = mkdtempSync(join(tmpdir(), "p2p-join-proof-"));
const env = { ...process.env, AUTH_KEY: key, SIGNAL_URL: signal, ROOM: room,
  TURN_URLS: "", TURN_USER: "", TURN_CRED: "" };
const headers = { Authorization: `Bearer ${key}` };
const hash = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const sockets: WebSocket[] = [];
function connect(name: string, selectedRoom = room): Promise<{ws: WebSocket; peers: {id:string;name:string}[]}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingClientUrl(signal, key, selectedRoom)); sockets.push(ws);
    const timer = setTimeout(() => reject(Error("peer-list timeout")), 15000);
    ws.onopen = () => ws.send(JSON.stringify({type:"identify", name}));
    ws.onerror = () => { clearTimeout(timer); reject(Error("WebSocket connection failed")); };
    ws.onmessage = event => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === "ping") ws.send(JSON.stringify({type:"pong"}));
      if (msg.type === "welcome") ws.send(JSON.stringify({type:"list-peers"}));
      if (msg.type === "error") { clearTimeout(timer); reject(Error(msg.code)); }
      if (msg.type === "peer-list") { clearTimeout(timer); resolve({ws, peers:msg.peers}); }
    };
  });
}
async function cli(script: string, args: string[], name: string) {
  const child = Bun.spawn(["bun", script, ...args], { cwd:join(import.meta.dir,"../dropbox"),
    env:{...env, PEER_NAME:name}, stdout:"pipe", stderr:"pipe" });
  const timeout = setTimeout(() => child.kill(), 90000);
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  clearTimeout(timeout);
  const safe = (out+err).split(key).join("[REDACTED]").split(encodeURIComponent(key)).join("[REDACTED]");
  if(code !== 0) throw Error(`${script} exit ${code}\n${safe}`);
  console.log(`${script} ${name}: exit 0`);
}
let receiver: ReturnType<typeof Bun.spawn> | undefined;
try {
  const config = await (await fetch(`${base}/api/config`, {headers})).json();
  if(config.room !== room) throw Error("deployed room does not match proof ROOM");
  if(config.iceServers.some((server: {urls:string}) => String(server.urls).startsWith("turn"))) throw Error("TURN unexpectedly configured");
  console.log(`TARGET ${base}; ROOM ${room}; TURN unset`);
  console.log(`HTTP no key ${(await fetch(`${base}/api/files`)).status}; with key ${(await fetch(`${base}/api/files`,{headers})).status}`);
  receiver = Bun.spawn(["bun", "receiver.ts"], {cwd:join(import.meta.dir,"../dropbox"),
    env:{...env, PEER_NAME:receiverName,SAVE_DIR:join(root,"received"),LOG_DIR:join(root,"logs")}, stdout:"ignore",stderr:"ignore"});
  let ready = false;
  for(let i=0;i<30;i++) {
    const listing = await connect(`m5-join-list-${suffix}`);
    ready = listing.peers.some(peer => peer.name === receiverName) && listing.peers.some(peer => peer.name === "p2p-dropbox");
    listing.ws.close(); await Bun.sleep(200);
    if(ready) break;
  }
  if(!ready) throw Error("second receiver did not register alongside p2p-dropbox");
  console.log(`SECOND IDENTITY ${receiverName}: discovered alongside p2p-dropbox`);
  let duplicateRejected = false;
  try { await connect(receiverName); } catch(error) { duplicateRejected = error instanceof Error && error.message === "ID-TAKEN"; }
  if(!duplicateRejected) throw Error("duplicate name was not rejected");
  console.log("DUPLICATE ID-TAKEN: PASS; incumbent remains");
  const isolated = await connect(receiverName, `proof-${suffix}`);
  if(isolated.peers.length !== 1 || isolated.peers[0].name !== receiverName) throw Error("room isolation failed");
  isolated.ws.close();
  console.log("ROOM isolation + same name in different room: PASS");
  const bytes = new Uint8Array(196731); for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+17)%256;
  const fixtureName = `join-p2p-${suffix}.bin`, httpName = `join-http-${suffix}.txt`;
  const fixture=join(root,fixtureName),httpFixture=join(root,httpName);
  await Bun.write(fixture,bytes); await Bun.write(httpFixture,"HTTP join recipe fixture\n");
  await cli("send.ts",["--to",receiverName,fixture],`m5-join-local-send-${suffix}`);
  const received = readdirSync(join(root,"received"),{recursive:true}).map(String).find(name=>name.endsWith(".bin"));
  if(!received) throw Error("local receiver fixture missing");
  const localHash=hash(readFileSync(join(root,"received",received)));
  if(localHash!==hash(bytes))throw Error("local receiver hash mismatch");
  console.log(`SECOND RECEIVER SHA256 source=${hash(bytes)} destination=${localHash} MATCH`);
  await cli("send.ts",["--to","p2p-dropbox",fixture],`m5-join-send-${suffix}`);
  await cli("upload.ts",["--url",base,httpFixture],`m5-join-http-${suffix}`);
  const listing = await (await fetch(`${base}/api/files`,{headers})).json();
  for(const [label,name,path] of [["WEBRTC",fixtureName,fixture],["HTTP",httpName,httpFixture]]) {
    const saved=listing.files.find((file:{name:string})=>file.name.endsWith(name));
    if(!saved)throw Error(`${label} destination not listed`);
    const response=await fetch(`${base}/api/files/${encodeURIComponent(saved.name)}?date=${encodeURIComponent(saved.date)}`,{headers});
    if(!response.ok)throw Error(`${label} download failed`);
    const source=hash(readFileSync(path)),destination=hash(new Uint8Array(await response.arrayBuffer()));
    if(source!==destination)throw Error(`${label} SHA256 mismatch`);
    console.log(`${label} SHA256 source=${source} destination=${destination} MATCH`);
    console.log(`${label} SAVED ${saved.date}/${saved.name}`);
  }
  console.log("JOIN RECIPE PASS: second receiver, distinct senders, uniqueness, rooms, WebRTC + HTTP");
} finally {
  sockets.forEach(ws=>ws.close());
  receiver?.kill(); if(receiver)await receiver.exited;
  rmSync(root,{recursive:true,force:true});
}
