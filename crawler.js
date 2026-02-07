import fs from "fs";
import { execSync } from "child_process";

const GH_TOKEN = process.env.GH_TOKEN;
const USER = "Cyberpross";

const START_AFTER = "swords-and-sandals-crusader_flash"; // 👈 resume point
let PACK_NUMBER = 13; // 👈 start from pack 13

const MAX_PACK_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_ITEM_SIZE = 100 * 1024 * 1024; // 100MB

// ---------- FETCH JSON ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

// ---------- DOWNLOAD WITH REDIRECT ----------
async function download(url, dest) {
  let res = await fetch(url, { redirect: "manual" });
  if (res.status === 302 || res.status === 301) {
    const newUrl = res.headers.get("location");
    res = await fetch(newUrl);
  }
  if (!res.ok) throw new Error("Download failed");

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

// ---------- GET ALL ITEMS ----------

// ---------- CREATE REPO ----------
function createRepo(repo) {
  execSync(`curl -X POST https://api.github.com/user/repos \
  -H "Authorization: token ${GH_TOKEN}" \
  -d '{"name":"${repo}"}'`, { stdio: "ignore" });
}

// ---------- PREPARE REPO ----------
function prepareRepo(repo) {
  if (!fs.existsSync("pack")) {
    try { createRepo(repo); } catch {}
    execSync(`git clone https://${GH_TOKEN}@github.com/${USER}/${repo}.git pack`);
  }

  process.chdir("pack");

  execSync("git config user.email 'bot@github.com'");
  execSync("git config user.name 'github-actions'");

  try { execSync("git checkout -b main"); }
  catch { execSync("git checkout main"); }

  try { execSync("git pull origin main --rebase"); } catch {}
}

// ---------- MAIN ----------
async function main() {
  console.log("🚀 RESUME DOWNLOADER");

  let items = await getAllItems();

  // 🔥 resume after specific game
  const index = items.indexOf(START_AFTER);
  items = items.slice(index + 1);

  console.log("▶ Resuming after:", START_AFTER);
  console.log("Remaining:", items.length);

  let size = 0;
  const repoName = `flash-pack-${String(PACK_NUMBER).padStart(3,"0")}`;
  prepareRepo(repoName);

  for (const id of items) {
    try {
      console.log("🔍", id);

      const meta = await getJSON(`https://archive.org/metadata/${id}`);
      const files = meta.files || [];

      const swf = files.find(f => f.name?.endsWith(".swf"));
      if (!swf) continue;
      if (+swf.size > MAX_ITEM_SIZE) continue;

      const img = files.find(f => f.name.match(/\.(png|jpg|jpeg)$/i));
      if (!img) continue;

      fs.mkdirSync(id, { recursive: true });

      const swfSize = await download(
        `https://archive.org/download/${id}/${swf.name}`,
        `${id}/${swf.name}`
      );

      const ext = img.name.split(".").pop();
      const imgSize = await download(
        `https://archive.org/download/${id}/${img.name}`,
        `${id}/c.${ext}`
      );

      size += swfSize + imgSize;

      execSync(`git add ${id}`);
      execSync(`git commit -m "Add ${id}" || echo skip`);
      execSync(`git push -u origin main --force`);

      console.log("✅ Uploaded:", id);

      // next pack
      if (size > MAX_PACK_SIZE) {
        process.chdir("..");
        fs.rmSync("pack", { recursive: true, force: true });
        PACK_NUMBER++;
        size = 0;

        const newRepo = `flash-pack-${String(PACK_NUMBER).padStart(3,"0")}`;
        prepareRepo(newRepo);
      }

    } catch (e) {
      console.log("❌ Skip:", id);
    }
  }

  console.log("🎉 FINISHED");
}

main();
