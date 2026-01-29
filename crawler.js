/**
 * FINAL VERSION – SKIP + RETRY SYSTEM
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
const SKIPPED_FILE = "skipped.txt";

const MAX_ITEM_MB = 100;
const PACK_LIMIT_MB = 1024;
const DELAY_MS = 1200;

const GH_TOKEN = process.env.GH_TOKEN;
if (!GH_TOKEN) throw new Error("GH_TOKEN missing");

/* ================= HELPERS ================= */

const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return { pack: 1, sizeMB: 0, completed: [] };
  }
  return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8"));
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

function loadSkipped() {
  if (!fs.existsSync(SKIPPED_FILE)) return new Set();
  return new Set(
    fs.readFileSync(SKIPPED_FILE, "utf8")
      .split("\n")
      .map(x => x.trim())
      .filter(Boolean)
  );
}

function saveSkipped(set) {
  fs.writeFileSync(SKIPPED_FILE, [...set].join("\n"));
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
  console.log(`📦 Using repo: ${repo}`);

  const check = await gh("GET", `/repos/${OWNER}/${repo}`);
  if (check?.message === "Not Found") {
    console.log(`🆕 Creating repo ${repo}`);
    await gh("POST", "/user/repos", { name: repo });
  }

  execSync("rm -rf pack");
  fs.mkdirSync("pack");
  process.chdir("pack");

  execSync("git init");
  execSync("git branch -M main");
  execSync(`git config user.name "github-actions[bot]"`);
  execSync(`git config user.email "41898282+github-actions[bot]@users.noreply.github.com"`);

  execSync(`git remote add origin https://${GH_TOKEN}@github.com/${OWNER}/${repo}.git`);
}

/* ================= DOWNLOAD ================= */

function rawDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error("redirect"));

    const proto = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    proto.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        file.close(); fs.unlinkSync(dest);
        return resolve(rawDownload(res.headers.location, dest, redirects + 1));
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

async function safeDownload(url, dest) {
  try {
    await rawDownload(url, dest);
    return true;
  } catch (e) {
    if (/HTTP (401|403|404)/.test(e.message)) {
      console.log(`⚠ Skipped (access denied)`);
      return false;
    }
    throw e;
  }
}

/* ================= PROCESS ITEM ================= */

async function processItem(item, progress, skipped) {
  console.log(`🔍 ${item}`);

  const meta = await fetch(`https://archive.org/metadata/${item}`).then(r => r.json());
  const files = meta.files || [];
  const swf = files.find(f => f.name?.endsWith(".swf"));

  if (!swf || !swf.size) return false;

  const sizeMB = swf.size / 1024 / 1024;
  if (sizeMB > MAX_ITEM_MB) return false;

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
  const ok = await safeDownload(base + swf.name, path.join(dir, `${item}.swf`));
  if (!ok) {
    skipped.add(item);
    saveSkipped(skipped);
    return false;
  }

  const img = files.find(f => /\.(png|jpg)$/i.test(f.name));
  if (img) {
    const ext = img.name.endsWith(".png") ? "png" : "jpg";
    await safeDownload(base + img.name, path.join(dir, `cover.${ext}`));
  }

  execSync("git add .");
  execSync(`git commit -m "Add ${item}"`);
  execSync("git push -u origin main");

  progress.completed.push(item);
  progress.sizeMB += sizeMB;
  saveProgress(progress);

  console.log(`✅ ${item}`);
  await sleep(DELAY_MS);
  return true;
}

/* ================= MAIN ================= */

async function main() {
  const items = fs.readFileSync(ITEMS_FILE, "utf8")
    .split("\n").map(x => x.trim()).filter(Boolean);

  const progress = loadProgress();
  const skipped = loadSkipped();

  console.log("🚀 Downloader started");
  await setupPack(progress.pack);

  for (const item of items) {
    if (progress.completed.includes(item)) continue;
    await processItem(item, progress, skipped);
  }

  // 🔁 RETRY SKIPPED ONCE
  console.log("🔁 Retrying skipped items...");
  for (const item of [...skipped]) {
    const ok = await processItem(item, progress, skipped);
    if (ok) skipped.delete(item);
    saveSkipped(skipped);
  }

  console.log("🎉 ALL DONE");
}

main().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
