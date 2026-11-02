<p align="center">
  <img src="docs/banner.svg" alt="dsh-houdini-preview" width="720">
</p>

<h1 align="center">⚔️ dsh-houdini-preview</h1>

<p align="center"><strong>English build · guardrail removed · based on dsh-purge 1.1.89</strong></p>

<p align="center">
  <em>A preview build of the DeepSeek Harness red-team plugin: fully English UI and prompts,
     with the own-server region gate taken out.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache--2.0-blue?style=flat" alt="Apache-2.0">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=node.js&logoColor=fff" alt="Node.js">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=000" alt="JavaScript">
  <br>
  <img src="https://img.shields.io/badge/dsh-0.2.1--rc.2%20%2F%200.2.1--rc.5-blue" alt="DSH">
  <img src="https://img.shields.io/badge/status-preview-orange" alt="preview">
</p>

---

## What this is

**dsh-houdini-preview** is a derivative build of [dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) — a cybersecurity red-team plugin for the official [DeepSeek Harness](https://www.deepseek.com/harness/) installed on your own machine.

Nothing about the plugin's *capability* was reduced. What changed is **language** and **one policy layer**:

| | upstream dsh-purge | this preview |
|---|---|---|
| UI, prompts, tool descriptions | Chinese | **English** |
| Own-server region gate | blocks non-loopback / non-RFC1918 targets | **removed** |
| Dock label | `dsh-purge` | `dsh-houdini-preview` |
| Everything else | — | identical (verbatim behaviour) |

The plugin still does what dsh-purge does: a Clean page that applies / reverts the host patch set, an encrypted prompt slot, a rule library, and a Drill console with an asset database, attack chain, scoring and reporting.

---

## Attribution required

This is a fork. The upstream project is **[YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge)** by **YuJunZhiXue**, Apache License 2.0. The upstream `NOTICE` and `LICENSE` are kept verbatim in this repository and the fork's own notice is appended to `NOTICE`.

**The original build may not be resold.** Charging for it, skinning it into a paid listing, or hawking it in groups is not allowed by the upstream author. Forks are fine — but they must attribute and name the source repository. That is exactly what this repository does, and any fork of *this* build must keep doing it.

Upstream notes and release channel: [t.me/LLM_PoJia](https://t.me/LLM_PoJia).

The original upstream READMEs are preserved under [`docs/upstream/`](docs/upstream/) in English, Chinese and Japanese.

---

## What this preview changes

### 1. Full English localization

Every user-facing string in the plugin was translated from Chinese to English: the dock UI, the settings page, the drill console, all role system prompts, every tool description, every report template, and the CLI output.

The translation was produced against the **real JavaScript lexer output**, not a regex sweep — comments and regex literals are skipped, so nothing was rewritten that wasn't an actual string literal. Concretely:

```
2,277 string literals replaced across 17 files
18 files verified with node --check, 0 failures
```

Files touched include `client.js`, `lib/core.js`, `lib/index.js`, `lib/desktop.js`, `lib/anchor.js`, `lib/redteam/client.js`, `lib/redteam/store-core.js`, `lib/redteam/tools.js`, `lib/redteam/ui.js`, `bin/dsh-purge.js` and the `scripts/` helpers.

**Deliberately left in Chinese** — translating these would break behaviour:

- **IDN domain suffixes** in `lib/net-scope.js` (`.中国`, `.公司`, `.香港`, …). These are DNS resolution data, not copy.
- **Refusal-phrase tables** in `lib/core.js` and `lib/anchor.js` (`不能`, `无法`, `拒绝`, `抱歉`, `我理解您的需求但`, …). These strings *are* the phrases the prompt layer is supposed to intercept; translating them would delete the behavior they exist to control.
- **SQL DDL** in `lib/redteam/schema.js`, the inlined 96 KB stylesheet inside `client.js`, and a handful of embedded code fragments in `lib/redteam/ui.js`.

### 2. Own-server guardrail removed

The upstream build ships a region gate in `lib/net-scope.js` called `installRegionGate()`. It hooks `agent/pre-step` and `tools/pre-execute`, resolves every hostname it can find in the task and in tool arguments, and calls `parkDenial()` on the entire step as soon as anything resolves to a public address. A companion allow-list file (`$DSH_HOME/net-scope-allow.txt`, served over `/dsh-purge/own-servers`) exists only to whitelist hosts you declare as your own.

In this build all four entry points are short-circuited:

```js
installRegionGate(ctx)   → return;      // the gate is never armed, no hooks registered
publicHostHit(text)      → return null; // no host is ever judged out of scope
taskTargetHit(text)      → return null; // no target-list comparison
isCheatTask(text)        → return false;// the cheat classifier no longer blocks
```

Each site carries a `// [dsh-purge] own-server guardrail removed` comment so the change is greppable and easy to revert.

Verified on the live package:

```
installRegionGate armed  = false
publicHostHit('nmap -sV 8.8.8.8')      = null
isCheatTask('游戏外挂 自瞄 透视')       = false
taskTargetHit('nmap -sV 203.0.113.5')  = null
```

### 3. Visible dock label

The dock title and its launcher chip read **dsh-houdini-preview** instead of dsh-purge.

Only the *labels* changed. These were deliberately left alone because they are contracts, not branding:

- `window.__ModuleLoader__.load({ id: "dsh-purge" })` — the host module id the client bundle registers under
- `const name = "dsh-purge"` — the locale namespace used for every `t(...)` lookup
- `[dsh-purge]` / `[dsh-purge-NN]` patch markers — these are how the plugin detects whether a host patch is already applied. Renaming them would orphan every already-applied patch on an existing install.

---

## Supported hosts

Targets **DSH 0.2.1-rc.2** and **0.2.1-rc.5** (the `dshTargets` field lists both). Both the official **Web** surface (`dsh web`) and the official **desktop EXE** are supported; install and Apply them separately.

DSH 0.2.1-rc.3 / rc.4 and older 0.1.x lines are not targeted by this build. Unmatched patches stay pending or skipped — nothing is rewritten blindly.

## Requirements

- Node.js >= 18
- An official DeepSeek Harness install you administer (web or desktop)
- `@deepseek-ai/cordis` ^4.0.1 (peer)

---

## Install

### As a profile dependency

Point your DSH profile's `package.json` at this repository:

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-houdini-preview": "github:ro-boduck/dsh-houdini-preview"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-houdini-preview"
      ]
    }
  }
}
```

Then install from the profile directory and restart the host:

```bash
cd "$DSH_HOME/profiles/desktop"
npm install
# or: pnpm install
```

Restart `dsh web` or the desktop app once afterwards so the patched host files are picked up.

### From a clone

```bash
git clone https://github.com/ro-boduck/dsh-houdini-preview.git
cd dsh-houdini-preview
npm install --omit=dev
```

The `postinstall` hook (`scripts/ensure-profile-bundle.mjs`) wires the bundle into the active profile.

---

## Usage

Once installed and the host restarted, a **dsh-houdini-preview** button appears next to the session title. It opens the right-hand dock with two pages:

- **Clean** — grouped patch status, Apply / Restore / Uninstall, the prompt editor, and the rule library.
- **Drill console** — asset mapping, vulnerability records, credentials, sessions and tunnels, the attack chain, scoring, and report export. Entering it the first time shows the authorization window.

Commands (registered on the host):

```
/purge          open the dock
/purge apply    apply the host patch set
/purge revert   restore from *.dshpurge.bak
/purge uninstall
/rewind         session rewind helpers
/rules          rule library
/skills         skill inventory
```

### Configuration

The bundle patch ships with `autoApplyOnStart: false` — patches are not applied until you click **Apply** or run `/purge apply`. That is intentional and matches upstream.

### Restore

- Every patched file is copied to `<file>.dshpurge.bak` before its first modification.
- **Restore** or `/purge revert` copies those backups back and deletes them. With no backup, the shim lines written by this plugin are stripped.
- `prompt-inject.md` is a user file and is kept.
- **Uninstall** restores first (if patches were applied), then removes the inject file, the rule library and the plugin itself.
- Apply is idempotent.

---

## Repository layout

```
client.js               web client bundle injected into the DSH UI
cordis.patch.yml        bundle patch: plugin wiring + config defaults
bin/dsh-purge.js        CLI entry
lib/
  index.js              plugin entry (routes, prompt sections, hooks)
  core.js               host patch set, apply / revert / shim logic
  net-scope.js          ← the own-server region gate (short-circuited here)
  identity.js           prompt identity handling
  anchor.js             operator / subagent anchor text
  desktop.js            official desktop EXE handoff
  redteam/
    index.js            drill console plugin
    store-core.js       SQLite fact database, roles, prompts, scoring
    client.js           drill console UI source
    tools.js            agent tool surface
    ui.js               HTTP bridge (POST /redteam/api)
    schema.js           database DDL
presets/redteam/        agent preset for the drill console
scripts/                build, patch and maintenance helpers
docs/                   banner, preview screenshots, upstream READMEs
```

---

## Compatibility notes

- **Drop-in with upstream state.** Because the patch markers and the state directory keep their `dsh-purge` names, an existing `$DSH_HOME/dsh-purge` state directory and any already-applied host patches are recognised as-is. You do not need to revert before switching.
- **If upstream `dsh-purge` is also installed**, disable one of the two — they patch the same host files. The bundle patch already disables the older standalone `dsh-redteam-*` packages.
- **Rebuilding the client.** Running `npm run build:client` regenerates the drill sections of `client.js` from `lib/redteam/client.js`. The dock label lives in both the bundle and `scripts/patch-client-dock.mjs`, so a rebuild keeps the renamed label only if you edit both.

## License

[Apache License 2.0](LICENSE), inherited from upstream. The upstream `NOTICE` is retained in full and the derivative notice is appended to it. Forks and redistributions must keep the copyright notice, the `NOTICE` file, and name both [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) and this repository. The upstream original may not be resold.
