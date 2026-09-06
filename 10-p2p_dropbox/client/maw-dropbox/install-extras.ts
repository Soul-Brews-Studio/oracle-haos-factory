#!/usr/bin/env bun
// Installs only our small decorator; existing lab03 sender/config stay untouched.
import { existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const args=process.argv.slice(2);
const remove=args[0]==="--remove";
if(remove)args.shift();
if(args.length>1)throw Error("Usage: bun install-extras.ts [--remove] [existing-dropbox-plugin-directory]");
const dir=resolve(args[0]||join(homedir(),".maw/plugins/dropbox"));
const manifest=join(dir,"plugin.json"),backup=join(dir,"plugin.before-extras.json"),entry=join(dir,"dropbox-extras.ts");
function regular(path:string){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw Error(`Expected regular file: ${path}`);}
function atomic(path:string,text:string){const temp=path+`.${crypto.randomUUID()}.tmp`;writeFileSync(temp,text,{mode:0o600,flag:"wx"});renameSync(temp,path);}
if(lstatSync(dir).isSymbolicLink())throw Error("Plugin directory must not be a symlink");
regular(manifest);const config=JSON.parse(readFileSync(manifest,"utf8"));
if(config.name!=="dropbox"||config.version!=="1.1.0"||config.runtime!=="bun-dev")throw Error("Requires existing lab03 maw dropbox v1.1.0 (bun-dev); no plugin is replaced automatically");
if(remove){
  if(config.entry!=="./dropbox-extras.ts")throw Error("Extras are not the current entry; refusing to replace another entry");
  regular(backup);const original=readFileSync(backup,"utf8");const saved=JSON.parse(original);
  if(saved.name!=="dropbox"||saved.entry!=="./index.ts")throw Error("Invalid extras backup");
  atomic(manifest,original);if(existsSync(entry)){regular(entry);if(readFileSync(entry,"utf8").includes("// maw-dropbox-extras v1"))unlinkSync(entry);}
  unlinkSync(backup);console.log("Restored original maw dropbox entry; config and transport unchanged");
}else{
  regular(join(dir,"index.ts"));regular(join(dir,"config.ts"));regular(join(dir,"dist/transport.js"));
  if(!["./index.ts","./dropbox-extras.ts"].includes(config.entry))throw Error("Unexpected plugin entry; refusing to overwrite another wrapper");
  if(existsSync(entry)){regular(entry);if(!readFileSync(entry,"utf8").includes("// maw-dropbox-extras v1"))throw Error("Existing extras filename is not ours");}
  if(config.entry==="./index.ts"){
    if(existsSync(backup))throw Error("Backup already exists; inspect it before installing");
    writeFileSync(backup,readFileSync(manifest),{mode:0o600,flag:"wx"});
  }else{regular(backup);}
  const source=readFileSync(join(import.meta.dir,"dropbox-extras.ts"),"utf8");
  atomic(entry,source);config.entry="./dropbox-extras.ts";atomic(manifest,JSON.stringify(config,null,2)+"\n");
  console.log("Installed maw dropbox extras: stats, dashboard, ui, share. Existing send/ls/status/url/config unchanged.");
}
