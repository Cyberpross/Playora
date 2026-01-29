/**
 * FINAL STABLE VERSION
 * - New repo per pack
 * - No duplicate uploads
 * - Git identity fixed
 */

import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { execSync } from "child_process";

/* ================= CONFIG ================= */

const OWNER = "Cyberpross";
const BASE_REPO = "flash-pack";

const ITEMS_FILE = "names.txt";
const PROGRESS_FILE = "progress.json";

const MAX_ITEM_MB = 100;
const PACK_LIMIT_MB = 1024;
const DELAY_MS = 1200;

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error("❌ GH_TOKEN missing");

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

async function gh(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "flash-crawler"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res.status === 204 ? {} : res.json();
}

async function setupPack(pack) {
  const repo = `${BASE_REPO}-${String(pack).padStart(3, "0")}`;
  console.log(`📦 Switching to pack: ${repo}`);

  const exists = await gh("GET", `/repos/${OWNER}/${repo}`);
  if (exists?.message === "Not Found") {
    console.log(`🆕 Creating repo ${repo}`);
    await gh("POST", "/user/repos", { name: repo });
  }

  // CLEAN workspace
  execSync("rm -rf pack");
  fs.mkdirSync("pack");
  process.chdir("pack");

  execSync("git init");
  execSync("git branch -M main");

  // ✅ FIX: set git identity
  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);

  execSync(`git remote add origin https://${GH_TOKEN}@github.com/${OWNER}/${repo}.git`);
}

/* ================= DOWNLOAD ================= */

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("Too many redirects"));

    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return resolve(download(res.headers.location, dest, redirects + 1));
      }

      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

/* ================= MAIN ================= */

async function main() {
  const items = fs.readFileSync(ITEMS_FILE, "utf8")
    .split("\n").map(x => x.trim()).filter(Boolean);

  const progress = loadProgress();

  console.log("🚀 Downloader started");
  await setupPack(progress.pack);

  for (const item of items) {

    if (progress.completed.includes(item) || progress.skipped.includes(item)) continue;

    console.log(`🔍 ${item}`);

    const meta = await fetch(`https://archive.org/metadata/${item}`).then(r => r.json());
    const files = meta.files || [];
    const swf = files.find(f => f.name?.endsWith(".swf"));

    if (!swf || !swf.size) {
      progress.skipped.push(item); saveProgress(progress); continue;
    }

    const sizeMB = swf.size / 1024 / 1024;
    if (sizeMB > MAX_ITEM_MB) {
      progress.skipped.push(item); saveProgress(progress); continue;
    }

    if (progress.sizeMB + sizeMB > PACK_LIMIT_MB) {
      progress.pack++;
      progress.sizeMB = 0;
      saveProgress(progress);
      process.chdir("..");
      await setupPack(progress.pack);
    }

    const dir = path.join("games", item);
    fs.mkdirSync(dir, { recursive: true });

    const base = `https://archive.org/download/${item}/`;
    await download(base + swf.name, path.join(dir, `${item}.swf`));

    const img = files.find(f => /\.(png|jpg)$/i.test(f.name));
    if (img) {
      const ext = img.name.endsWith(".png") ? "png" : "jpg";
      await download(base + img.name, path.join(dir, `cover.${ext}`));
    }

    execSync("git add .");
    execSync(`git commit -m "Add ${item}"`);
    execSync("git push -u origin main");

    progress.completed.push(item);
    progress.sizeMB += sizeMB;
    saveProgress(progress);

    console.log(`✅ ${item}`);
    await sleep(DELAY_MS);
  }

  console.log("🎉 ALL DONE");
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
