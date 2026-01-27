/**
 * Internet Archive Flash downloader
 *
 * Features:
 * - Reads items from names.txt
 * - Downloads ONLY:
 *    - first .swf (<= 100 MB)
 *    - first image (jpg/png) -> renamed to c.jpg / c.png
 * - Creates folder per item
 * - Tracks total size per pack (~1 GB)
 * - Auto-creates new GitHub repo per pack
 * - Commits + pushes after each item
 * - Resume-safe (progress.json)
 */

import fs from "fs";
import path from "path";
import https from "https";
import { execSync } from "child_process";

const OWNER = "Cyberpross";               // GitHub username
const BASE_REPO = "game";           // flash-pack-001, 002, ...
const ITEMS_FILE = "names.txt";
const PROGRESS_FILE = "progress.json";

const MAX_ITEM_MB = 100;
const PACK_LIMIT_MB = 1024;

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  console.error("❌ GH_TOKEN not found in env");
  process.exit(1);
}

/* ----------------- helpers ----------------- */

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {
      pack: 1,
      sizeMB: 0,
      completed: [],
      skipped: []
    };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function ghApi(method, url, body) {
  return fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      "Authorization": `token ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json"
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

async function createRepo(pack) {
  const name = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`🆕 Creating repo: ${name}`);

  await ghApi("POST", "/user/repos", {
    name,
    private: false
  });

  execSync(`git remote set-url origin https://${GH_TOKEN}@github.com/${OWNER}/${name}.git`);
  execSync(`git push -u origin main`);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

/* ----------------- main ----------------- */

async function main() {
  const items = fs.readFileSync(ITEMS_FILE, "utf8")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  const progress = loadProgress();

  console.log("🚀 Downloader started");
  console.log(`📦 Current pack: ${progress.pack}`);

  for (const item of items) {
    if (progress.completed.includes(item) || progress.skipped.includes(item)) {
      console.log(`⏭ Skipping already processed: ${item}`);
      continue;
    }

    console.log(`🔍 Checking item: ${item}`);

    const meta = await fetch(`https://archive.org/metadata/${item}`).then(r => r.json());
    const files = meta.files || [];

    const swf = files.find(f => f.name?.toLowerCase().endsWith(".swf"));
    if (!swf || !swf.size) {
      console.log(`⚠ No SWF found: ${item}`);
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    const swfMB = Number(swf.size) / 1024 / 1024;

    if (swfMB > MAX_ITEM_MB) {
      console.log(`🚫 Skipped ${item} (${swfMB.toFixed(1)} MB > 100 MB)`);
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    // pack size check
    if (progress.sizeMB + swfMB >= PACK_LIMIT_MB) {
      progress.pack++;
      progress.sizeMB = 0;
      saveProgress(progress);
      await createRepo(progress.pack);
    }

    const itemDir = path.join("games", item);
    fs.mkdirSync(itemDir, { recursive: true });

    const baseUrl = `https://archive.org/download/${item}/`;

    console.log(`⬇ Downloading SWF`);
    await download(baseUrl + swf.name, path.join(itemDir, `${item}.swf`));

    const img = files.find(f => /\.(jpg|png)$/i.test(f.name));
    if (img) {
      const ext = img.name.toLowerCase().endsWith(".png") ? "png" : "jpg";
      console.log(`🖼 Downloading image`);
      await download(baseUrl + img.name, path.join(itemDir, `c.${ext}`));
    }

    progress.completed.push(item);
    progress.sizeMB += swfMB;
    saveProgress(progress);

    execSync("git add .");
    execSync(`git commit -m "Add ${item}"`);
    execSync("git push");

    console.log(`✅ Finished ${item}`);
  }

  console.log("🎉 All items processed");
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
