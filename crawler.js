/**
 * Flash Games Archive Crawler
 * Single-file version
 * Node.js 18+
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import fetch from "node-fetch";

const GH_TOKEN = process.env.GH_TOKEN;
const USERNAME = "Cyberpross"; // <-- CHANGE THIS
const START_ID = "swords-and-sandals-2";
const MAX_MB = Number(process.env.MAX_REPO_SIZE_MB || 1024);
const STATE_FILE = ".state.json";

if (!GH_TOKEN) {
  console.error("❌ GH_TOKEN not set");
  process.exit(1);
}

let state = {
  page: 1,
  index: 0,
  repo: 1,
  size: 0,
  started: false
};

if (fs.existsSync(STATE_FILE)) {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

gitConfig();
createRepo(`game-${state.repo}`);

while (true) {
  const api =
    `https://archive.org/advancedsearch.php?q=collection:softwarelibrary_flash_games` +
    `&fl[]=identifier&sort[]=identifier asc&rows=100&page=${state.page}&output=json`;

  const res = await fetch(api);
  const json = await res.json();
  const docs = json.response.docs;

  if (!docs.length) break;

  for (let i = state.index; i < docs.length; i++) {
    const id = docs[i].identifier;

    if (!state.started) {
      if (id === START_ID) state.started = true;
      else continue;
    }

    const added = await processGame(id);
    state.size += added;
    state.index = i + 1;
    saveState();

    if (state.size >= MAX_MB) {
      pushRepo();
      state.repo++;
      state.size = 0;
      state.index = i + 1;
      saveState();
      createRepo(`game-${state.repo}`);
    }
  }

  state.page++;
  state.index = 0;
  saveState();
}

pushRepo();
console.log("✅ Done");


// ================= FUNCTIONS =================

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function gitConfig() {
  execSync(`git config --global user.name "flash-bot"`);
  execSync(`git config --global user.email "bot@users.noreply.github.com"`);
}

function createRepo(name) {
  console.log(`📦 Creating repo ${name}`);

  execSync(
    `curl -s -X POST -H "Authorization: token ${GH_TOKEN}" ` +
    `https://api.github.com/user/repos ` +
    `-d '{"name":"${name}","private":false}'`
  );

  execSync("rm -rf .git");
  execSync("git init");
  execSync("git branch -M main");
  execSync(`git remote add origin https://${GH_TOKEN}@github.com/${USERNAME}/${name}.git`);
}

function pushRepo() {
  execSync("git add .");
  execSync(`git commit -m "add flash games" || true`);
  execSync("git push -u origin main");
}

async function processGame(id) {
  console.log(`🎮 ${id}`);

  const meta = await fetch(`https://archive.org/metadata/${id}`).then(r => r.json());
  const files = meta.files || [];

  const swf = files.find(f => f.name?.toLowerCase().endsWith(".swf"));
  if (!swf) return 0;

  const img = files.find(f => f.name?.match(/\.(png|jpg|jpeg)$/i));
  const title = safeName(meta.metadata?.title || id);
  const dir = path.join(process.cwd(), title);

  fs.mkdirSync(dir, { recursive: true });

  await download(id, swf.name, path.join(dir, "game.swf"));

  let cover = "";
  if (img) {
    cover = img.name.toLowerCase().endsWith(".png") ? "c.png" : "c.jpg";
    await download(id, img.name, path.join(dir, cover));
  }

  fs.writeFileSync(path.join(dir, "index.html"), html(cover));

  return (swf.size || 0) / 1024 / 1024;
}

async function download(id, file, dest) {
  const url = `https://archive.org/download/${id}/${file}`;
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function html(img) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="../ruffle/ruffle.js"></script>
</head>
<body>
${img ? `<img src="${img}" style="display:none">` : ""}
<embed src="game.swf" width="800" height="600">
</body>
</html>`;
}

function safeName(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
