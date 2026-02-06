import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const GH_TOKEN = process.env.GH_TOKEN;
const USER = "Cyberpross";
const MAX_PACK_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_ITEM_SIZE = 100 * 1024 * 1024; // 100MB

// ---------- FETCH JSON ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ---------- FETCH WITH REDIRECT ----------
async function downloadFile(url, dest) {
  let res = await fetch(url, { redirect: "manual" });

  if (res.status === 302 || res.status === 301) {
    const newUrl = res.headers.get("location");
    console.log("🔁 Redirect →", newUrl);
    res = await fetch(newUrl);
  }

  if (!res.ok) throw new Error("Download failed");

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buffer);
  return buffer.length;
}

// ---------- SEARCH ALL ITEMS ----------
async function getAllItems() {
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789";
  const all = new Set();

  for (const letter of letters) {
    console.log("🔎 Searching:", letter);
    let page = 1;

    while (true) {
      const url =
        "https://archive.org/advancedsearch.php" +
        `?q=collection:flash AND mediatype:software AND identifier:${letter}*` +
        "&fl[]=identifier&rows=1000" +
        `&page=${page}&output=json`;

      const json = await getJSON(url);
      if (!json.response?.docs?.length) break;

      json.response.docs.forEach(d => all.add(d.identifier));
      console.log(`📄 ${letter} page ${page} → ${all.size}`);
      page++;
    }
  }

  return Array.from(all);
}

// ---------- CREATE REPO ----------
function createRepo(repo) {
  console.log("🆕 Creating repo", repo);
  execSync(`curl -X POST https://api.github.com/user/repos \
  -H "Authorization: token ${GH_TOKEN}" \
  -d '{"name":"${repo}"}'`, { stdio: "ignore" });
}

// ---------- CLONE / PREP REPO ----------
function prepareRepo(repo) {
  if (!fs.existsSync("pack")) {
    try { createRepo(repo); } catch {}
    execSync(`git clone https://${GH_TOKEN}@github.com/${USER}/${repo}.git pack`);
  }
  process.chdir("pack");

  execSync("git config user.email 'bot@github.com'");
  execSync("git config user.name 'github-actions'");

  try {
    execSync("git checkout -b main");
  } catch {
    try { execSync("git checkout main"); } catch {}
  }

  try { execSync("git pull origin main --rebase"); } catch {}
}

// ---------- MAIN ----------
async function main() {
  console.log("🚀 Downloader started");

  const items = await getAllItems();
  console.log("🎯 Total unique items:", items.length);

  let pack = 1;
  let size = 0;
  let processed = new Set();
  let skipped = [];
  let failed = [];

  function startPack() {
    const repo = `flash-pack-${String(pack).padStart(3,"0")}`;
    console.log("📦 Using repo:", repo);
    prepareRepo(repo);

    if (fs.existsSync("processed.txt"))
      processed = new Set(fs.readFileSync("processed.txt","utf8").split("\n"));
  }

  startPack();

  for (const id of items) {
    if (processed.has(id)) continue;

    try {
      console.log("🔍", id);
      const meta = await getJSON(`https://archive.org/metadata/${id}`);
      const files = meta.files || [];

      const swf = files.find(f => f.name?.endsWith(".swf"));
      if (!swf) { skipped.push(id); continue; }

      if (+swf.size > MAX_ITEM_SIZE) {
        console.log("⏭ >100MB skip");
        skipped.push(id);
        continue;
      }

      const img = files.find(f => f.name.match(/\.(png|jpg|jpeg)$/i));
      if (!img) { skipped.push(id); continue; }

      const folder = path.join(process.cwd(), id);
      fs.mkdirSync(folder, { recursive: true });

      const swfSize = await downloadFile(
        `https://archive.org/download/${id}/${swf.name}`,
        path.join(folder, swf.name)
      );

      const imgExt = img.name.split(".").pop();
      const imgSize = await downloadFile(
        `https://archive.org/download/${id}/${img.name}`,
        path.join(folder, `c.${imgExt}`)
      );

      size += swfSize + imgSize;

      execSync(`git add ${id}`);
      execSync(`git commit -m "Add ${id}" || echo skip`);
      execSync(`git push -u origin main --force`);

      fs.appendFileSync("processed.txt", id + "\n");

      if (size > MAX_PACK_SIZE) {
        process.chdir("..");
        fs.rmSync("pack", { recursive: true, force: true });
        pack++;
        size = 0;
        startPack();
      }

    } catch (e) {
      console.log("❌ Failed:", id);
      failed.push(id);
    }
  }

  // ---------- RETRY FAILED ----------
  console.log("🔁 Retrying failed items...");
  for (let i=0;i<5;i++) {
    const retry = [...failed];
    failed = [];

    for (const id of retry) {
      try {
        console.log("Retry:", id);
        const meta = await getJSON(`https://archive.org/metadata/${id}`);
        const files = meta.files || [];
        const swf = files.find(f => f.name?.endsWith(".swf"));
        const img = files.find(f => f.name.match(/\.(png|jpg|jpeg)$/i));
        if (!swf || !img) continue;

        const folder = path.join(process.cwd(), id);
        fs.mkdirSync(folder, { recursive: true });

        await downloadFile(`https://archive.org/download/${id}/${swf.name}`, path.join(folder, swf.name));
        await downloadFile(`https://archive.org/download/${id}/${img.name}`, path.join(folder, "c.png"));

        execSync(`git add ${id}`);
        execSync(`git commit -m "Retry ${id}" || echo skip`);
        execSync(`git push -u origin main --force`);
      } catch { failed.push(id); }
    }
  }

  fs.writeFileSync("skipped.txt", skipped.join("\n"));
  console.log("🎉 ALL DONE");
}

main();
