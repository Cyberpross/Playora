import fs from "fs";
import fetch from "node-fetch";
import { execSync } from "child_process";

const USER = "Cyberpross";
const TOKEN = process.env.GH_TOKEN;
const API = "https://archive.org/advancedsearch.php";

// ---------------- GIT SAFE ----------------

function git(cmd){
  execSync(cmd,{stdio:"inherit"});
}

function repoExists(name){
  try{
    execSync(`gh repo view ${USER}/${name}`);
    return true;
  }catch{return false;}
}

function createOrClone(repo){
  if(!repoExists(repo)){
    console.log("🆕 Creating repo",repo);
    execSync(`gh repo create ${repo} --public --confirm`);
  }

  git(`rm -rf pack || true`);
  git(`git clone https://${TOKEN}@github.com/${USER}/${repo}.git pack`);
  process.chdir("pack");

  git('git config user.email "bot@github.com"');
  git('git config user.name "flash-bot"');

  if(!fs.existsSync(".git/refs/heads/main")){
    git("git checkout -b main");
  }
}

// commit ONLY if changes
function pushChanges(msg){
  git("git add .");

  let changed=true;
  try{
    execSync("git diff --cached --quiet");
    changed=false;
  }catch{}

  if(!changed){
    console.log("⏭️ No changes");
    return;
  }

  git(`git commit -m "${msg}"`);

  try{ git("git pull --rebase"); }catch{}
  git("git push -u origin main");
}

// --------------- LOAD / SAVE STATE ----------------

function loadProgress(){
  if(!fs.existsSync("progress.json")){
    return { pack:1, index:0 };
  }
  return JSON.parse(fs.readFileSync("progress.json","utf8"));
}

function saveProgress(p){
  fs.writeFileSync("progress.json",JSON.stringify(p,null,2));
  pushChanges("update progress");
}

// ---------------- FETCH ALL ITEMS ----------------

async function fetchAllItems(){
  const letters="abcdefghijklmnopqrstuvwxyz0123456789";
  const set=new Set();

  for(const l of letters){
    let page=1;
    while(true){
      const url=`${API}?q=collection:flash&fl[]=identifier&rows=100&page=${page}&output=json&sort[]=identifier asc&query=${l}`;
      const res=await fetch(url).then(r=>r.json());
      const docs=res.response.docs;
      if(!docs.length) break;

      docs.forEach(d=>set.add(d.identifier));
      console.log(`📄 ${l} page ${page} total ${set.size}`);
      page++;
    }
  }

  const arr=[...set];
  fs.writeFileSync("all_items.json",JSON.stringify(arr));
  return arr;
}

// ---------------- DOWNLOAD ----------------

async function downloadItem(id){
  try{
    const meta=await fetch(`https://archive.org/metadata/${id}`).then(r=>r.json());
    const swf=meta.files.find(f=>f.name.endsWith(".swf"));
    if(!swf) return "skip";

    const url=`https://archive.org/download/${id}/${swf.name}`;
    const res=await fetch(url);

    if(Number(res.headers.get("content-length"))>100_000_000){
      fs.appendFileSync("bigfiles.txt",id+"\n");
      return "big";
    }

    const buf=await res.arrayBuffer();
    fs.mkdirSync(id,{recursive:true});
    fs.writeFileSync(`${id}/${swf.name}`,Buffer.from(buf));

    return "ok";
  }catch{
    fs.appendFileSync("skip.txt",id+"\n");
    return "fail";
  }
}

// ---------------- MAIN ----------------

async function main(){

  let items;
  if(fs.existsSync("all_items.json")){
    items=JSON.parse(fs.readFileSync("all_items.json"));
  }else{
    items=await fetchAllItems();
  }

  console.log("🎯 Total:",items.length);

  const state=loadProgress();
  const PACK_SIZE=1000;

  for(let i=state.index;i<items.length;i++){

    const packNum=Math.floor(i/PACK_SIZE)+1;
    const repo=`flash-pack-${String(packNum).padStart(3,"0")}`;

    if(state.pack!==packNum){
      process.chdir("..");
      createOrClone(repo);
      state.pack=packNum;
    }

    const id=items[i];
    console.log("🔍",i,id);

    const result=await downloadItem(id);

    if(result==="ok"){
      pushChanges(`Add ${id}`);
    }

    state.index=i+1;
    saveProgress(state);
  }

  // -------- RETRY SKIPS 5 TIMES --------
  if(fs.existsSync("skip.txt")){
    let list=[...new Set(fs.readFileSync("skip.txt","utf8").split("\n"))];
    fs.writeFileSync("skip.txt","");

    for(let r=1;r<=5;r++){
      console.log("🔁 Retry round",r);
      for(const id of list){
        const res=await downloadItem(id);
        if(res==="ok") pushChanges(`retry ${id}`);
      }
    }
  }

  console.log("🎉 ALL DONE");
}

main();
