import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import fetch from "node-fetch";

/* =============== CONFIG ================= */

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) {
  console.error("❌ GH_TOKEN missing");
  process.exit(1);
}

const COLLECTION_API =
  "https://archive.org/advancedsearch.php?q=collection:softwarelibrary_flash_games&fl[]=identifier&rows=100&page=";

const SIZE_LIMIT = 1024 * 1024 * 1024; // 1 GB per repo
const MAX_SWF_SIZE = 95 * 1024 * 1024; // 95 MB SWF limit

/* ======================================= */

let repoIndex = 1;
let currentSize = 0;
let page = 1;

const baseDir = process.cwd();
const progressFile = path.join(baseDir, "processed.json");

/* ========== LOAD PROGRESS =============== */

let processed = new Set();
if (fs.existsSync(progressFile)) {
  processed = new Set(JSON.parse(fs.readFileSync(progressFile, "utf8")));
}

/* ======================================= */

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

function saveProgress() {
  fs.writeFileSync(progressFile, JSON.stringify([...processed], null, 2));
  run("git add processed.json");
  try {
    run(`git commit -m "update progress"`);
  } catch {}
}

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "FlashCrawler/1.0" },
  });

  const text = await res.text();

  // Archive.org sometimes returns HTML
  if (text.trim().startsWith("<")) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createRepo(name) {
  console.log(`🚀 Creating repo ${name}`);

  run("rm -rf repo");
  run("mkdir repo");
  process.chdir("repo");

  run("git init");
  run("git config user.name github-actions");
  run("git config user.email actions@github.com");

  run(
    `git remote add origin https://x-access-token:${TOKEN}@github.com/${process.env.GITHUB_REPOSITORY_OWNER}/${name}.git`
  );

  fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `token ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, private: false }),
  });
}

async function processGame(id) {
  if (processed.has(id)) {
    console.log(`⏭️ already processed: ${id}`);
    return 0;
  }

  console.log(`🎮 ${id}`);

  const meta = await fetchJSON(`https://archive.org/metadata/${id}`);
  if (!meta || !meta.files) return 0;

  const swf = meta.files.find(f => f.name?.endsWith(".swf"));
  if (!swf) return 0;

  if (swf.size && swf.size > MAX_SWF_SIZE) {
    console.log(`⏭️ SWF too large, skipping`);
    processed.add(id);
    saveProgress();
    return 0;
  }

  const img = meta.files.find(f =>
    f.name?.match(/\.(png|jpg|jpeg)$/i)
  );

  const gameDir = path.join(process.cwd(), id);
  fs.mkdirSync(gameDir, { recursive: true });

  const swfBuf = await fetch(
    `https://archive.org/download/${id}/${swf.name}`
  ).then(r => r.arrayBuffer());

  const swfPath = path.join(gameDir, "game.swf");
  fs.writeFileSync(swfPath, Buffer.from(swfBuf));

  let imgName = "";
  if (img) {
    const ext = img.name.split(".").pop();
    imgName = `c.${ext}`;

    const imgBuf = await fetch(
      `https://archive.org/download/${id}/${img.name}`
    ).then(r => r.arrayBuffer());

    fs.writeFileSync(
      path.join(gameDir, imgName),
      Buffer.from(imgBuf)
    );
  }

  fs.writeFileSync(
    path.join(gameDir, "index.html"),
    `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${id}</title>
<script src="../ruffle/ruffle.js"></script>
</head>
<body>
${imgName ? `<img src="${imgName}" width="300"><br>` : ""}
<embed src="game.swf" width="800" height="600"></embed>
</body>
</html>`
  );

  processed.add(id);
  saveProgress();

  run("git add .");
  try {
    run(`git commit -m "add ${id}"`);
  } catch {}

  const size = fs.statSync(swfPath).size;
  currentSize += size;

  return size;
}

async function main() {
  createRepo(`game-${repoIndex}`);

  while (true) {
    const data = await fetchJSON(COLLECTION_API + page);
    if (!data || !data.response?.docs) {
      page++;
      continue;
    }

    const docs = data.response.docs;
    if (docs.length === 0) break;

    for (const d of docs) {
      await processGame(d.identifier);

      if (currentSize >= SIZE_LIMIT) {
        run("git branch -M main");
        run("git push -u origin main");

        process.chdir(baseDir);
        repoIndex++;
        currentSize = 0;
        createRepo(`game-${repoIndex}`);
      }
    }

    page++;
  }

  run("git branch -M main");
  run("git push -u origin main");
}

main();
