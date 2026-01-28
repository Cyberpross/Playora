/**
 * FINAL Internet Archive Flash Downloader
 * Controller repo = Playora (NO uploads here)
 * Game repos = flash-pack-001, 002, ...
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execSync } from "child_process";

/* ================= CONFIG ================= */

const OWNER = "Cyberpross";
const BASE_REPO = "flash-pack";      // flash-pack-001...
const ITEMS_FILE = "names.txt";
const PROGRESS_FILE = "progress.json";

const MAX_ITEM_MB = 100;
const PACK_LIMIT_MB = 1024;
const DELAY_MS = 1200;

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) {
  console.error("❌ GH_TOKEN missing");
  process.exit(1);
}

/* ================= UTILS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { pack: 1, sizeMB: 0, completed: [], skipped: [] };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

/* ================= GITHUB ================= */

async function ghApi(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      "Authorization": `token ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "flash-downloader"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.status === 204 ? {} : res.json();
}

async function ensurePackRepo(pack) {
  const name = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`📦 Using repo: ${name}`);

  const check = await ghApi("GET", `/repos/${OWNER}/${name}`);
  if (check?.message === "Not Found") {
    console.log(`🆕 Creating repo: ${name}`);
    await ghApi("POST", "/user/repos", { name, private: false });
  }

  if (!fs.existsSync(".git")) {
    execSync("git init");
    execSync("git branch -M main");
  }

  execSync("git remote remove origin || true");
  execSync(
    `git remote add origin https://${GH_TOKEN}@github.com/${OWNER}/${name}.git`
  );

  execSync("git pull origin main || true");
}

/* ================= DOWNLOAD ================= */

function download(url, dest, redirects = 0, retried = false) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));

    const proto = url.startsWith("https://") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; IA-Downloader/1.0)"
      }
    }, res => {

      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        console.log(`🔁 Redirect → ${res.headers.location}`);
        return resolve(download(res.headers.location, dest, redirects + 1, retried));
      }

      if (res.statusCode === 401 && !retried && url.startsWith("https://")) {
        file.close(); fs.unlinkSync(dest);
        console.log("🔄 401 → retry via HTTP");
        return resolve(
          download(url.replace("https://","http://"), dest, redirects, true)
        );
      }

      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", err => {
      file.close(); fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/* ================= MAIN ================= */

async function main() {
  const items = fs.readFileSync(ITEMS_FILE, "utf8")
    .split("\n").map(x => x.trim()).filter(Boolean);

  const progress = loadProgress();

  console.log("🚀 Downloader started");

  // 🚫 NEVER push to Playora
  await ensurePackRepo(progress.pack);

  for (const item of items) {

    if (progress.completed.includes(item) || progress.skipped.includes(item)) {
      console.log(`⏭ Already handled: ${item}`);
      continue;
    }

    console.log(`🔍 Item: ${item}`);

    const meta = await fetch(`https://archive.org/metadata/${item}`)
      .then(r => r.json());

    const files = meta.files || [];
    const swf = files.find(f => f.name?.toLowerCase().endsWith(".swf"));

    if (!swf || !swf.size) {
      console.log("⚠ No SWF");
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    const swfMB = Number(swf.size) / 1024 / 1024;
    if (swfMB > MAX_ITEM_MB) {
      console.log(`🚫 Skip (${swfMB.toFixed(1)} MB)`);
      progress.skipped.push(item);
      saveProgress(progress);
      continue;
    }

    if (progress.sizeMB + swfMB >= PACK_LIMIT_MB) {
      progress.pack++;
      progress.sizeMB = 0;
      saveProgress(progress);
      await ensurePackRepo(progress.pack);
    }

    const dir = path.join("games", item);
    fs.mkdirSync(dir, { recursive: true });

    const base = `https://archive.org/download/${item}/`;

    console.log("⬇ SWF");
    await download(base + swf.name, path.join(dir, `${item}.swf`));

    const img = files.find(f => /\.(jpg|png)$/i.test(f.name));
    if (img) {
      const ext = img.name.toLowerCase().endsWith(".png") ? "png" : "jpg";
      console.log("🖼 Image");
      await download(base + img.name, path.join(dir, `c.${ext}`));
    }

    progress.completed.push(item);
    progress.sizeMB += swfMB;
    saveProgress(progress);

    execSync("git add .");
    execSync(`git commit -m "Add ${item}"`);
    execSync("git push");

    console.log(`✅ Done: ${item}`);
    await sleep(DELAY_MS);
  }

  console.log("🎉 ALL DONE");
}

main().catch(err => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
