import fs from "fs";
import { execSync } from "child_process";
import fetch from "node-fetch";

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) throw new Error("GH_TOKEN missing");

const START_ID = "15-aevil_202304"; // 👈 hard start
const COLLECTION = "softwarelibrary_flash_games";

let processed = new Set(
  fs.existsSync("processed.json")
    ? JSON.parse(fs.readFileSync("processed.json"))
    : []
);

function run(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

async function getMeta(id) {
  const r = await fetch(`https://archive.org/metadata/${id}`);
  return r.json();
}

async function nextItems(cursor) {
  const url = `https://archive.org/metadata/${COLLECTION}?cursor=${cursor}`;
  const r = await fetch(url);
  return r.json();
}

async function main() {
  run("git init");
  run("git config user.name bot");
  run("git config user.email bot@bot");

  let cursor = START_ID;
  let started = false;

  while (true) {
    const data = await nextItems(cursor);
    if (!data?.members?.length) break;

    for (const item of data.members) {
      if (!started) {
        if (item.identifier === START_ID) started = true;
        else continue;
      }

      if (processed.has(item.identifier)) continue;

      console.log("🎮", item.identifier);

      const meta = await getMeta(item.identifier);
      const swf = meta.files?.find(f => f.name.endsWith(".swf"));
      if (!swf) continue;

      const dir = `games/${item.identifier}`;
      fs.mkdirSync(dir, { recursive: true });

      const buf = await fetch(
        `https://archive.org/download/${item.identifier}/${swf.name}`
      ).then(r => r.arrayBuffer());

      fs.writeFileSync(`${dir}/game.swf`, Buffer.from(buf));

      processed.add(item.identifier);
      fs.writeFileSync("processed.json", JSON.stringify([...processed], null, 2));

      run("git add .");
      run(`git commit -m "add ${item.identifier}"`);
    }

    cursor = data.cursor;
    if (!cursor) break;
  }

  run("git branch -M main");
  run(
    `git remote add origin https://x-access-token:${TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`
  );
  run("git push -u origin main");
}

main();
