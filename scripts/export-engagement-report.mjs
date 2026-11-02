#!/usr/bin/env node
/**
 * 把一个靶标的得分报告导出成可移动的交付包：`<outDir>/<靶标>-红队成果复现报告.md` + `<outDir>/shots/`。
 *
 * 面板下载的 markdown 里，证据截图走绝对路径，发给别人会碎图。
 * 这里把 shots/ 一并拷到输出目录，markdown 用相对路径。
 *
 * 跑法：
 *   node scripts/export-engagement-report.mjs
 *   node scripts/export-engagement-report.mjs --out ~/交付/靶标名
 *   node scripts/export-engagement-report.mjs --engagement <id>
 */
import { mkdirSync, writeFileSync, cpSync, rmSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RedteamStore } from "../lib/redteam/store-core.js";

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i === -1 || argv[i + 1] === undefined ? fallback : argv[i + 1];
};

const root = process.env.REDTEAM_HOME || join(process.env.DSH_HOME || join(homedir(), ".dsh"), "redteam");
const store = new RedteamStore(root);
const id = argOf("engagement", store.activeEngagementId());
if (!id) {
  console.error("No usable target: create one in the panel first, or specify it with --engagement <id>");
  process.exit(1);
}
const outDir = resolve(argOf("out", process.cwd()));
mkdirSync(outDir, { recursive: true });

const shotsSrc = join(root, "engagements", id, "shots");
const shotsDst = join(outDir, "shots");
if (existsSync(shotsSrc)) {
  rmSync(shotsDst, { recursive: true, force: true });
  cpSync(shotsSrc, shotsDst, { recursive: true });
}

const rep = store.scoreReport(id, { shotRef: "relative" });
const name = String(rep.target || id).replace(/[/\\:*?"<>|]/g, "_");
const outFile = join(outDir, name + "-redteam-result-reproduction-report.md");
writeFileSync(outFile, rep.markdown, "utf8");
store.close();

const imgs = (rep.markdown.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length;
console.log("✓ report: " + outFile);
console.log("  total " + rep.summary.points + " pts · " + rep.items.length + " bodies · embedded screenshots " + imgs + " shots"
  + (existsSync(shotsDst) ? "（shots/ " + readdirSync(shotsDst).length + " files, just copy them out together with the report)" : ""));
