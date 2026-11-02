#!/usr/bin/env node

import * as core from "../lib/core.js";
import * as rules from "../lib/rules.js";
import * as reapply from "../lib/reapply.js";

const args = process.argv.slice(2);

function printStatus(state) {
  const out = [];
  out.push("dsh-purge Status");
  out.push("  Host / surface " + (state.surface || "web"));
  out.push("  DSH_HOME      " + state.dsh_home);
  if (state.desktop_install) out.push("  Desktop install       " + state.desktop_install);
  if (state.ai_base) {
    out.push("  Plugin root / root  " + state.ai_base);
    for (const [key, fp] of Object.entries(state.files)) {
      out.push(`    ${key.padEnd(22)} ${fp}`);
    }
  } else {
    out.push("  Plugin root / root  " + core.missingAiBaseMessage());
  }
  out.push(`  shim directory      ${state.shim_dir || "not found"}`);
  out.push(`  backup  ${state.has_backup ? "yes" : "no"}`);
  out.push(`  Injection file       ${state.override_path}`);
  out.push(`  Injection status       ${state.override_status}`);
  out.push("");
  out.push(`  Patches ${state.patches_applied}/${core.ALL_PATCHES.length} scrubbed, ${state.patches_pending} pending`
    + (state.patches_drifted ? `, ${state.patches_drifted} drifted (upstream text changed, pattern needs updating)` : ""));
  if (state.host_version) {
    const compat = state.host_supported === false ? `  ← unsupported: plugin declares ${state.host_target || "?"}` : "";
    out.push(`  Host version / host  ${state.host_version}${compat}`);
  }
  for (const p of core.ALL_PATCHES) {
    const s = state.patch_status[p.id];
    const mark = s === "applied" ? "✓" : s === "pending" ? "✗" : s === "drifted" ? "!" : "·";
    out.push(`    ${mark} [#${String(p.id).padEnd(2)}] ${p.name.padEnd(30)} ${p.layer}/${p.layer_en} — ${s}`);
  }
  out.push("");
  out.push(`  shim: dsh.cmd=${state.shim_cmd}  dsh.ps1=${state.shim_ps1}  dsh=${state.shim_bin}`);
  return out.join("\n");
}

async function main() {
  const mode = args.find((a) => ["--apply", "--revert", "--uninstall", "--status", "--edit", "--help"].includes(a));

  if (mode === "--help" || args.includes("-h")) {
    console.log(`dsh-purge usage:
  dsh-purge --status     show status
  dsh-purge --apply      apply all scrubs (prompts + code + shim + override)
  dsh-purge --revert     revert to the originals
  dsh-purge --uninstall  uninstall the plugin (reverts first if applied)
  dsh-purge --edit       edit the injection file prompt-inject.md
  dsh-purge --help       show help`);
    return;
  }

  const state = await core.gatherState();
  console.log(printStatus(state));
  console.log("");

  if (mode === "--apply") {
    if (!state.ai_base) {
      console.log("[ERROR] " + core.missingAiBaseMessage());
      console.log("  fix: point DSH_BASE at the @deepseek-ai directory containing dsh-agent-instructions/lib");
      process.exit(1);
    }
    const inject = rules.resolveInjectText(state.dsh_home);
    if (!inject.text) {
      console.log("[ERROR] Prompts and rule sets are both empty; add a prompt first");
      process.exit(1);
    }
    const { hosts, report } = await core.applyPatchesAllHosts(core.ALL_PATCHES, {
      preserveClientBundles: false,
      forApply: true,
    });
    for (const h of hosts) console.log(`  Host / host → ${h.aiBase}`);
    for (const r of report) {
      const m = r.status === "applied" ? "✓ scrubbed" : r.status === "already" ? "- up to date" : r.status === "missing_file" ? "⚠ file missing" : `✗ ${r.status}`;
      console.log(`  ${m} patch #${String(r.patch_id).padEnd(2)} ${r.name}`);
    }
    const flashHost = hosts[0]?.aiBase || state.ai_base;
    const flash = core.silenceCmdFlash(flashHost);
    console.log(`  cmd-flash=${flash.entry} phase-1=${flash.phase1} ok=${flash.ok}`);
    if (hosts.length > 1) {
      console.log(`  multi-host: ${hosts.length} copies of @deepseek-ai already cleaned`);
    }
    console.log(inject.source === "rule"
      ? "  - uses the current rule set, does not rewrite prompt files"
      : "  - uses the existing prompt file");
    if (state.shim_dir) {
      const r = await core.patchShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "patched") console.log(`  ✓ shim ${fname} injected / injected`);
        else if (st === "already_patched") console.log(`  - shim ${fname} already injected / already injected`);
        else if (st === "missing") console.log(`  - shim ${fname} missing / missing`);
        else console.log(`  ⚠ shim ${fname}: ${st}`);
      }
    } else {
      console.log("  ⚠ shim directory not found, skipping injection");
    }
    const failed = core.summarizeApplyReport(report).failed || [];
    console.log("");
    if (failed.length > 0) {
      console.log(`✗ Completed with ${failed.length} failed patch(es) / finished with ${failed.length} failed patch(es)`);
      process.exit(1);
    }
    // 面板点应用会打戳；CLI 也要打，否则下次启动 settle 以为没对齐又重打一遍（#202）。
    try {
      reapply.markPatchesApplied();
    } catch (e) {
      console.log(`  ⚠ failed to write applied stamp: ${e && e.message ? e.message : e}`);
    }
    console.log("All done. Restart dsh to take effect.");
  } else if (mode === "--revert") {
    if (state.ai_base || core.enumeratePatchAiBases().length) {
      const { reverted, errors } = await core.revertAllHosts();
      for (const p of reverted) console.log(`  ✓ Reverted ${p}`);
      for (const [p, e] of errors) console.log(`  ⚠ restore failed ${p}: ${e}`);
      if (reverted.length === 0) console.log("  - no patch backup to restore / no patch backup");
    }
    if (state.shim_dir) {
      const r = await core.revertShim(state.shim_dir);
      for (const [fname, st] of Object.entries(r)) {
        if (st === "reverted" || st === "stripped_inject") console.log(`  ✓ shim ${fname}: ${st}`);
        else console.log(`  - shim ${fname}: ${st}`);
      }
    }
    console.log("");
    console.log("Revert done. Restart dsh to restore.");
    console.log("Note: prompt-inject.md preserved (user file) / prompt-inject.md kept (user file)");
  } else if (mode === "--uninstall") {
    const { uninstallPurge } = await import("../lib/uninstall.js");
    const result = await uninstallPurge();
    if (result.applied) console.log("  Patches detected; reverted to the originals.");
    else console.log("  No applied patches detected; plugin files will still be removed.");
    if (result.override?.removed) console.log(`  Deleted ${result.override.path}`);
    if (result.stripped?.length) console.log(`  removed from profile: ${result.stripped.join(", ")}`);
    for (const e of result.errors || []) console.log(`  ⚠ ${e}`);
    if (!result.ok) {
      console.log("  Uninstall aborted: revert failed, plugin files were not deleted.");
      process.exit(1);
    }
    /* 命令行卸载没有「重启后助手」这一步：插件目录不会自己消失，得在这里删。
       （界面卸载是把这一步交给独立助手，等端口释放后再删。） */
    const fs = await import("node:fs");
    for (const dir of result.cleanup || []) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 }); }
      catch (e) { console.log(`  ⚠ could not delete ${dir}: ${e && e.message ? e.message : e}`); }
    }
    console.log("");
    console.log("Uninstall complete. Restart dsh.");
  } else if (mode === "--edit") {
    const r = core.editOverride(state.dsh_home);
    if (!r.ok && r.needCreate) {
      await core.installOverride(state.dsh_home, true);
      console.log(`  ✓ Created default injection file: ${state.override_path}`);
      core.editOverride(state.dsh_home);
    } else {
      console.log(`  → Opened ${r.editor} to edit the injection file: ${r.path}`);
    }
    console.log("  Restart dsh after editing for it to take effect.");
  } else {
    console.log("Nothing is scrubbed by default; use --apply to apply the scrub.");
  }
}

main().catch((e) => {
  console.error("[dsh-purge] error:", e);
  process.exit(1);
});
