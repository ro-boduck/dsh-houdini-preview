/**
 * 技能修复文案（零依赖，纯 ESM）
 *
 * 用途：给控制台「技能库」页签用 —— 每个**不可用**的技能都要能直接告诉用户"How to fix"，
 * 而不是只报"What is missing"。`skill-availability.js` 负责判定（缺环境变量 / 缺工具 / 占位符没填 / 被同名技能盖住），
 * 这里负责把每一类判定翻译成可执行的中文步骤：
 *   · `TOOL_FIXES`   —— 逐工具的装法（与 `scripts/redteam-setup.sh` 保持一致：能自动装的就让人跑该脚本）
 *   · `SKILL_FIXES`  —— 逐技能的额外修复步骤（FOFA_KEY、VPS 地址、浏览器扩展…）
 *   · `toolNameOfPath` / `fixesForIssue` —— 把"a certain path does not exist"这类判定转成具体建议
 *
 * 文案约定：中文、一句话说清"What it is / how to fix it"、命令一律用反引号包住、不编造 URL 与版本号、
 * 正文不用 markdown 强调符（面板按纯文本渲染）。`fixesForIssue()` 按判定分支给出的建议是**单行**的
 * （当列表项渲染不会塌）；回退到 `SKILL_FIXES` 时可能带换行 —— 技能文案允许 1–3 行。
 */

/** 仓库自带的一键修复入口（工具下载、FOFA_KEY/VPS 引导都在这一个脚本里）。 */
const SETUP = 'bash $DSH_HOME/redteam/setup.sh --yes'

/** 完全不知道缺什么时的兜底建议。 */
const GENERIC_FIX = 'Executed by the user as `' + SETUP + '` fills in tools and configuration (idempotent, safe to rerun; missing ones are downloaded, corrupted ones deleted and re-downloaded),'
  + 'Changes to `$DSH_HOME/.env` only take effect after restarting `dsh web`; if it still fails, reinstall the redteam plugin and run the health check again.'

/** 工具箱附件实际装了什么。不要写成「缺了就从附件里解出来」。 */
const TOOLKIT_TARBALL = 'The upstream dsh-redteam-mode release asset `dsh-redteam-mode-<version>-toolkit.tar.gz` (currently holding only README, a few skill md files, and redteam-setup.sh; none of the binaries or scripts below)'

/* ── 逐工具修法 ───────────────────────────────────────────────────────────── */

const FRP_FIX = {
  what: 'frp intranet tunneling: `frps` runs on the VPS as the server, `frpc` runs on the target as the client (two binaries from the same release package)',
  install: 'Run `' + SETUP + '` extracts both `frpc` + `frps` in one go into `$DSH_HOME/redteam/toolkit/frp/`;'
    + 'If the script does not cover it, take `frp_<version>_linux_amd64.tar.gz` manually from fatedier/frp GitHub releases, extract it, put `frpc`/`frps` in the same directory, and `chmod +x`',
}

const LIGOLO_FIX = {
  what: 'ligolo-ng TUN tunnel (`proxy` server + `agent` on the target side), an alternative channel besides chisel/frp; needs root to create the virtual NIC',
  install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/ligolo/proxy` and `.../ligolo/agent`;'
    + 'Or take `proxy_*_linux_amd64.tar.gz` / `agent_*_linux_amd64.tar.gz` from nicocha30/ligolo-ng GitHub releases, extract them, place them under `toolkit/ligolo/` with the names above, and `chmod +x`',
}

export const TOOL_FIXES = {
  /* ── setup.sh 会下载到 toolkit/ 的二进制 ── */
  fscan: {
    what: 'Comprehensive intranet scanning (liveness/ports/service identification/28 classes of weak passwords/unauthorized access/high-risk vulnerabilities, v2.2.1)',
    install: 'Run `' + SETUP + '` fills in `$DSH_HOME/redteam/toolkit/fscan/fscan`;'
      + 'If only `fscan.zip` was downloaded without extraction, extract the `fscan` binary manually and `chmod +x` it; if the script still cannot fill it in, download the matching-platform binary from shadow1ng/fscan GitHub releases (including `fscan_windows_x64.exe`, `fscan_linux_arm64`) into that directory',
  },
  gogo: {
    what: 'Intranet mapping and fingerprinting engine (v2.15.0, active + passive fingerprinting, key-information extraction, nuclei template POCs)',
    install: 'setup.sh only prints a hint for gogo and does not download it (upstream asset names are inconsistent): run `' + SETUP + '` and read the hint,'
      + 'then fetch the binaries per platform yourself from chainreactors/gogo GitHub releases; put the main program at `$DSH_HOME/redteam/toolkit/gogo/gogo`, the Windows/arm64 variants (`gogo_windows_amd64.exe`, `gogo_linux_arm64`) in the same directory, and `chmod +x` them all',
  },
  suo5: {
    what: 'suo5: the core intranet-breach tool that builds a SOCKS5 tunnel over WebShell/HTTP (v2.2.0, static Go, no dependencies)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/suo5/suo5-linux-amd64`;'
      + 'Or take `suo5-linux-amd64` from zema1/suo5 GitHub releases, put it at that path, and `chmod +x`',
  },
  chisel: {
    what: 'chisel HTTP tunnel (server and client are the same binary, v1.12.0)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/chisel/chisel`;'
      + 'Or take `chisel_<version>_linux_amd64.gz` from jpillora/chisel GitHub releases, then `gunzip` and `chmod +x`',
  },
  frp: FRP_FIX,
  frpc: FRP_FIX,
  frps: FRP_FIX,
  subfinder: {
    what: 'Passive subdomain enumeration (ProjectDiscovery, v2.16.0, multi-source aggregation)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/subfinder/subfinder`;'
      + 'Or take `subfinder_<version>_linux_amd64.zip` from projectdiscovery/subfinder GitHub releases, extract it, put it in place, and `chmod +x`',
  },
  dnsx: {
    what: 'Bulk DNS resolution/brute force/wildcard filtering (ProjectDiscovery, v1.3.1)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/dnsx/dnsx`;'
      + 'Or take `dnsx_<version>_linux_amd64.zip` from projectdiscovery/dnsx GitHub releases, extract it, put it in place, and `chmod +x`',
  },
  naabu: {
    what: 'High-speed port scanning (ProjectDiscovery, v2.6.1; SYN needs root, non-root adds `-scan-type c`)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/naabu/naabu`;'
      + 'Or take `naabu_<version>_linux_amd64.zip` from projectdiscovery/naabu GitHub releases, extract it, put it in place, and `chmod +x`',
  },
  httpx: {
    what: 'HTTP liveness / title / status code / tech stack probing (ProjectDiscovery build, v1.12.0; `/usr/bin/httpx` is the Python httpx library CLI, not this)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/httpx/httpx`;'
      + 'Or take `httpx_<version>_linux_amd64.zip` from projectdiscovery/httpx GitHub releases, extract it, put it in place, and `chmod +x`;'
      + 'On the command line call it through the wrapper script `pd-httpx` (see the `pd-httpx` entry)',
  },
  ksubdomain: {
    what: 'Stateless subdomain brute force (knownsec ksubdomain v0.7, faster than dnsx brute force; needs root to send packets)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/ksubdomain/ksubdomain`;'
      + 'Or take the linux archive from knownsec/ksubdomain GitHub releases, extract it, put it in place, and `chmod +x`',
  },
  ligolo: LIGOLO_FIX,
  'ligolo-proxy': LIGOLO_FIX,
  'ligolo-agent': LIGOLO_FIX,
  gowitness: {
    what: 'Bulk web page screenshots for evidence (sensepost/gowitness)',
    install: 'Run `' + SETUP + '` installs to `$DSH_HOME/redteam/toolkit/gowitness/gowitness`;'
      + 'Or take `gowitness-<version>-linux-amd64` from sensepost/gowitness GitHub releases, put it in place, and `chmod +x` —— '
      + 'Note that downloads must be complete (a truncated binary is present with the right permissions yet produces zero output when run)',
  },
  oneforall: {
    what: 'OneForAll subdomain-collection bundle (v0.4.5, source + `.venv`, slow but thorough)',
    install: 'Run `' + SETUP + '` will drop the source into `$DSH_HOME/redteam/toolkit/oneforall/OneForAll-0.4.5/` and set up the `.venv` dependencies;'
      + 'Failing to install does not affect the main line —— just use `subfinder` + `ksubdomain` instead',
  },
  vps: {
    what: 'VPS login method (`REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY`) and the relay script `vps.sh`: the landing end for reverse shells, payload delivery, and tunnel exits',
    install: 'Run `' + SETUP + '` prompts for the VPS address and private key path; put the private key at `$DSH_HOME/redteam/toolkit/vps/id_rsa` and `chmod 600` (check connectivity with '
      + '`ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> \\\'echo ok\\\'` to verify);'
      + 'The script `$DSH_HOME/redteam/toolkit/vps/vps.sh` is not in the toolkit attachment: write it yourself as an executable script following the subcommands of the `vps-reverse-shell` skill (it must at least have `serve <port>` and `exec`) and `chmod +x` it',
  },
  'nuclei-templates': {
    what: 'nuclei template library (13,000+ templates; both `nuclei -t` and `redteam_poc_search` rely on it)',
    install: 'Run `' + SETUP + '` installs into `~/.local/nuclei-templates`; you can also run `nuclei -update-templates` separately (no more than once a week);'
      + 'Fewer than 1000 templates means the download was incomplete; rerun it and use `nuclei -tl` to confirm the template library is intact',
  },

  /* ── 技能里引用、但 setup.sh 不下载，工具箱附件里也没有 ── */
  dirsearch: {
    what: 'Directory/file brute force (Python, v0.5.0, complete wordlists, report-friendly, ships its own runtime)',
    install: 'Not in setup.sh\'s download list: take the source package from maurosoria/dirsearch GitHub releases and put it under `$DSH_HOME/redteam/toolkit/dirsearch/` '
      + '(ensure `toolkit/dirsearch/dirsearch` is executable and `chmod +x`); meanwhile `feroxbuster` / `ffuf` / `gobuster` can stand in',
  },
  behinder: {
    what: 'Behinder v4.1 client + encrypted shell templates (`toolkit/Behinder/server/*.jsp|php|aspx`, the main WebShell delivery tool)',
    install: 'setup.sh does not download it,' + TOOLKIT_TARBALL + '. Get the client yourself from the Behinder release page and put it under `toolkit/Behinder/`;'
      + 'When you only need the shell templates, just keep the seven templates in `toolkit/Behinder/server/` in place (without a GUI you can still swap the key with `sed` to generate); `java -jar` is required, so Java must be installed locally',
  },
  godzilla: {
    what: 'Godzilla v4.0.1 client (`godzilla.jar`, GUI generates fully encrypted JSP/PHP/ASPX payloads)',
    install: 'setup.sh does not download it,' + TOOLKIT_TARBALL + '. Get `godzilla.jar` yourself from the Godzilla release page and put it under `toolkit/Godzilla/`;'
      + 'Launching requires Java (`apt install openjdk-17-jre`) and a graphical session (`DISPLAY=:10.0`)',
  },
  antsword: {
    what: 'AntSword (Loader + source directory; on first launch select the source directory `antSword-2.1.16`)',
    install: 'setup.sh does not download it,' + TOOLKIT_TARBALL + '. Get the Loader and source directory from the official AntSword repo and put them under `toolkit/AntSword/` ('
      + '`toolkit/AntSword/AntSword-Loader-v4.0.3-linux-x64/AntSword` must be executable)',
  },
  netexec: {
    what: 'netexec (nxc) intranet lateral-movement/protocol enumeration tool (`toolkit/netexec/`; on Kali you can also `apt install netexec`)',
    install: '`apt install netexec`; the local toolkit copy is at `$DSH_HOME/redteam/toolkit/netexec/`,'
      + 'If missing, take it from ' + TOOLKIT_TARBALL + ' extracted, or use `pipx install netexec` per the official docs',
  },

  /* ── 技能里出现、setup.sh 不管的本机脚本/二进制 ── */
  'pd-httpx': {
    what: 'Wrapper script for ProjectDiscovery httpx (`~/.local/bin/pd-httpx`)——avoids a name clash with the Python httpx library CLI',
    install: 'First run `' + SETUP + '` installs `$DSH_HOME/redteam/toolkit/httpx/httpx`, then rebuild the wrapper script and grant it execute permission:'
      + '`printf \'#!/usr/bin/env bash\\nexec "\${DSH_HOME:-$HOME/.dsh}/redteam/toolkit/httpx/httpx" "$@"\\n\' > ~/.local/bin/pd-httpx && chmod +x ~/.local/bin/pd-httpx`',
  },
  'kimi-chrome': {
    what: 'Launcher script that starts a browser "drivable by the Kimi WebBridge extension" (`~/.local/bin/kimi-chrome`)',
    install: 'First install a browser: `apt install google-chrome-stable` (or `apt install chromium`); then create `~/.local/bin/kimi-chrome`:'
      + 'Defaults to `exec /usr/bin/google-chrome --no-first-run --no-default-browser-check "$@"`; when `KIMI_BROWSER=chromium` use `/usr/bin/chromium` instead,'
      + 'At the start also run `systemctl start kimi-webbridge` as a fallback to bring the daemon up, and finish with `chmod +x ~/.local/bin/kimi-chrome`',
  },
  'kimi-webbridge': {
    what: 'Kimi WebBridge local daemon (systemd service `kimi-webbridge`, listening on `127.0.0.1:10086`; the skills use it to drive a real browser)',
    install: 'The daemon lives at `~/.kimi-webbridge/bin/kimi-webbridge` and is managed by `/etc/systemd/system/kimi-webbridge.service`:'
      + 'After reinstalling, run `sudo systemctl enable --now kimi-webbridge`, then confirm `"running": true` with `~/.kimi-webbridge/bin/kimi-webbridge status`;'
      + 'The browser extension is installed automatically by enterprise policy from the Chrome Web Store (ID `fldmhceldgbpfpkbgopacenieobmligc`); on Chrome 137+ do not use unpacked loading',
  },
  chromium: {
    what: 'Chromium browser (zero-dependency way to grab the rendered DOM / screenshots / generate PDFs headlessly, `/usr/bin/chromium`)',
    install: '`apt install chromium` (`google-chrome-stable` also works); usage: `/usr/bin/chromium --headless=new --no-sandbox --dump-dom <url>`,'
      + 'Add `--screenshot=runs/shot.png` for screenshots',
  },
  'playwright-cli': {
    what: 'Playwright CLI (browser automation when you need clicks/waits/multiple tabs, `npx --yes @playwright/cli@latest`)',
    install: '`npx --yes @playwright/cli@latest`; if the browser is missing run `npx playwright install chromium`;'
      + 'Always pass `--browser chromium` when calling it (the default chrome channel errors with `Chromium distribution \\\'chrome\\\' is not found`)',
  },

  /* ── 系统工具（setup.sh 只体检，缺了用 apt 补） ── */
  nmap: {
    what: 'Port/service/script scanning (bundled with Kali; the mainstay of active scanning)',
    install: '`apt install nmap`; SYN scanning (`-sS`) needs `sudo`; without privileges use `-sT`',
  },
  masscan: {
    what: 'Ultra-high-speed port scanning (sweeping large ranges; noisy)',
    install: '`apt install masscan`; sending packets needs root, so always bound `--rate` and the authorized scope first',
  },
  nuclei: {
    what: 'Template-based vulnerability scanning (the mainstay for Nday/1day detection; locally at `/usr/bin/nuclei`)',
    install: '`apt install nuclei`; after installing, top up the template library too: `nuclei -update-templates` (templates live in `~/.local/nuclei-templates`)',
  },
  sqlmap: {
    what: 'SQL injection detection and exploitation',
    install: '`apt install sqlmap`',
  },
  ffuf: {
    what: 'Web fuzz / directory brute force (fastest and most flexible; supports multiple wordlists, vhost, parameter fuzzing)',
    install: '`apt install ffuf`',
  },
  feroxbuster: {
    what: 'Recursive directory brute force (Rust, follows directory levels automatically; the first choice for directory brute force)',
    install: '`apt install feroxbuster`',
  },
  gobuster: {
    what: 'Lightweight directory/DNS/vhost brute force (dir/dns/vhost three modes)',
    install: '`apt install gobuster`',
  },
  hydra: {
    what: 'Online weak-password brute force (50+ protocols: SSH/FTP/RDP/SMB/MySQL/MSSQL/web forms)',
    install: '`apt install hydra`',
  },
  john: {
    what: 'John the Ripper offline hash cracking (CPU route, suits small wordlists/rules)',
    install: '`apt install john`; if wordlists are missing first `apt install wordlists` then `gunzip /usr/share/wordlists/rockyou.txt.gz`',
  },
  hashcat: {
    what: 'hashcat offline hash/password cracking (GPU preferred; CPU is very slow)',
    install: '`apt install hashcat`; first run `hashcat --identify hashes.txt` to confirm the mode number (e.g. NTLM `-m 1000`, Kerberoast `-m 13100`)',
  },
  wpscan: {
    what: 'WordPress vulnerability and user enumeration scanning',
    install: '`apt install wpscan`; when the vulnerability database is needed, run `wpscan --update` as prompted',
  },
  nikto: {
    what: 'Web server configuration and known-issue scanning',
    install: '`apt install nikto`',
  },
  whatweb: {
    what: 'Web fingerprinting (CMS/framework/middleware/version)',
    install: '`apt install whatweb`',
  },
  amass: {
    what: 'Subdomain enumeration and asset mapping (OWASP Amass)',
    install: '`apt install amass`; passive mode `amass enum -passive -d <domain>`',
  },
  theharvester: {
    what: 'Public-source email/subdomain/host collection (theHarvester)',
    install: '`apt install theharvester`',
  },
  msfconsole: {
    what: 'Metasploit framework (`exploit/multi/handler` to catch reverse shells, `web_delivery` to deliver payloads)',
    install: '`apt install metasploit-framework` (provides `msfconsole`); run `msfdb init` before first use',
  },
  searchsploit: {
    what: 'Local Exploit-DB search (find public POCs by component/version)',
    install: '`apt install exploitdb` (provides `searchsploit`); update the database with `searchsploit -u`',
  },
  proxychains4: {
    what: 'Proxies a single command\'s TCP traffic into the intranet (used with a socks5 tunnel)',
    install: '`apt install proxychains4`; only use `-f` pointing at a temporary config under `runs/` (e.g. `proxychains4 -f runs/proxychains-1080.conf ...`); leave `/etc/proxychains4.conf` untouched',
  },
  socat: {
    what: 'Full-TTY reverse-shell listeners / port forwarding (steadier than nc, gets you a PTY)',
    install: '`apt install socat`',
  },
  nc: {
    what: 'netcat: reverse-shell listeners and connectivity tests (`nc -lvnp <port>`)',
    install: '`apt install netcat-traditional` (provides `nc`; Debian\'s `netcat-openbsd` works too)',
  },
  tmux: {
    what: 'Session persistence: listeners and tunnels must run inside tmux, otherwise an SSH disconnect loses them',
    install: '`apt install tmux`; usage: `tmux new -s handler`, `tmux a -t handler`',
  },
  impacket: {
    what: 'Impacket protocol suite (PtH/PsExec/WMI/DCOM/Kerberos/credential dumping; Kali ships 61 `impacket-*` commands)',
    install: '`apt install python3-impacket`; common commands `impacket-wmiexec` / `impacket-psexec` / `impacket-secretsdump` / `impacket-GetNPUsers`',
  },
  enum4linux: {
    what: 'SMB/domain environment information enumeration (users, shares, groups, password policy)',
    install: '`apt install enum4linux` (newer releases also have `enum4linux-ng`)',
  },
  'redis-cli': {
    what: 'Redis client (read-only probing and shell-writing against unauthorized Redis)',
    install: '`apt install redis-tools` (provides `redis-cli`)',
  },
  mysql: {
    what: 'MySQL/MariaDB client (unauthorized/weak-password MySQL access to pull data)',
    install: '`apt install default-mysql-client` (on Kali it is `mariadb-client`)',
  },
}

/* ── 逐技能修法 ───────────────────────────────────────────────────────────── */

export const SKILL_FIXES = {
  'active-scan': 'Install scanners: `apt install nmap masscan`; if `toolkit/naabu/naabu` is missing, run `' + SETUP + '`。'
    + 'As non-root add `-scan-type c` to naabu; SYN scans with nmap/masscan require `sudo`; confirm the target is within the authorized scope before scanning.',

  'asset-correlation': 'A pure record/correlation skill that depends on no external tools and reads no environment variables; unavailability usually means a missing skill file or an old plugin version —— '
    + 'Reinstall the redteam plugin, restart `dsh web`, then confirm the `redteam_asset_link` tool is available.',

  'browser-automation': 'Install a browser: `apt install chromium` (or `google-chrome-stable`); on the playwright path also run `npx playwright install chromium`.'
    + 'Always pass `--browser chromium` when calling it (the default chrome channel errors with `Chromium distribution \\\'chrome\\\' is not found`).',

  'campaign-planning': 'A pure planning skill that depends on no external tools and reads no environment variables; unavailability usually means a missing skill file —— '
    + 'Reinstall the plugin and restart the current host. Before starting, fix the objective/scope/time box/noise budget/stop conditions, then assign execution roles.',

  'chisel-tunnel': 'Fill in the binary `toolkit/chisel/chisel`: run `' + SETUP + '`。\n'
    + 'Both tunnel ends use the VPS: confirm `$DSH_HOME/.env` contains `REDTEAM_VPS_HOST` / `REDTEAM_VPS_USER` / `REDTEAM_VPS_KEY`,'
    + 'Before commands run `set -a; . "$DSH_HOME/.env"; set +a`; after changing `.env` you must restart `dsh web`, and remember to open the tunnel ports in the security group.',

  'cn-proxy-pool': 'Depends only on `curl` / `python3` (`apt install curl` if missing); being unavailable usually means a missing skill file —— reinstall the plugin and restart `dsh web`.'
    + 'Specify the proxy per command only, with `-proxy` / `-x` / `--proxy`; leave the local system proxy and `/etc/proxychains4.conf` alone.',

  'credential-attack': '`apt install hydra hashcat john`; for wordlists run `sudo apt install wordlists` then `gunzip /usr/share/wordlists/rockyou.txt.gz`.'
    + 'Without a local GPU `hashcat` is very slow; prefer a small dictionary plus rules (`-r /usr/share/hashcat/rules/best64.rule`).',

  'deepseek-web-intel': 'Configure `DEEPSEEK_API_KEY`: write it into `$DSH_HOME/.env` (never into the repo/commands/reports), then restart the current host.'
    + 'Without the key this skill is unavailable; other skills are unaffected. Search results are written to disk; never put the key into reports or command lines.',

  'dir-bruteforce': '`apt install feroxbuster ffuf gobuster`; `toolkit/dirsearch/dirsearch` is not in setup.sh\'s download list —— '
    + 'Get the source from maurosoria/dirsearch GitHub releases, put it under `$DSH_HOME/redteam/toolkit/dirsearch/`, and ensure it is executable.',

  'fofa-recon': 'Configure `FOFA_KEY`: log in at <https://fofa.info> → personal center → API Key.\\n'
    + 'Write it into `$DSH_HOME/.env` (`FOFA_KEY=your key`, `chmod 600`) or temporarily `export FOFA_KEY=…`; it only takes effect in this process after restarting `dsh web`;'
    + 'A self-test with `curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY"` must return `"error":false`.\n'
    + 'The user can also run `' + SETUP + '` (the script writes it and validates it on the spot).',

  'frp-tunnel': 'Fill in `toolkit/frp/frps` and `toolkit/frp/frpc`: run `' + SETUP + '` (extracts both binaries in one go).\\n'
    + 'The VPS side needs `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY` (`$DSH_HOME/.env`); before commands run `set -a; . "$DSH_HOME/.env"; set +a`,'
    + 'After changing it, restart `dsh web` and open the frps listening port in the cloud security group.',

  'fscan-intranet': 'Fill in `toolkit/fscan/fscan`: run `' + SETUP + '`; if only `fscan.zip` was downloaded, extract `fscan` manually and `chmod +x` it.\\n'
    + '`<your VPS_IP>` in the skill body is a placeholder: write `REDTEAM_VPS_HOST=<real IP>` in `$DSH_HOME/.env` and restart `dsh web`,'
    + 'Or edit `$DSH_HOME/skills/fscan-intranet.md` directly and replace `<your VPS_IP>` with the real address (payload service: run `vps.sh serve 9100` on the VPS).',

  'gogo-intranet': '`gogo` is not downloaded automatically by setup.sh: fetch the binary per platform from chainreactors/gogo GitHub releases,'
    + 'Put it at `$DSH_HOME/redteam/toolkit/gogo/gogo` (Windows/arm64 variants in the same directory) and `chmod +x`.\\n'
    + 'Fill the `<your VPS_IP>` placeholder the `fscan-intranet` way: write `REDTEAM_VPS_HOST` in `.env`, restart `dsh web`,'
    + 'Or edit `$DSH_HOME/skills/gogo-intranet.md` directly and replace the placeholder.',

  'kimi-webbridge': 'Two things: the browser extension and the launcher. The extension is installed automatically by enterprise policy from the Chrome Web Store (ID `fldmhceldgbpfpkbgopacenieobmligc`),'
    + 'On Chrome 137+ stop using `--load-extension`; without Chrome/Chromium first `apt install chromium` or install `google-chrome-stable`.\\n'
    + 'Create the launcher `~/.local/bin/kimi-chrome` (starts `/usr/bin/google-chrome` by default; `KIMI_BROWSER=chromium` switches to Chromium) and `chmod +x` it;'
    + 'Bring the daemon up with `sudo systemctl enable --now kimi-webbridge`.\\n'
    + 'When `extension_connected` in `curl -s http://127.0.0.1:10086/status` is `false`, start the browser (`kimi-chrome`) first and then check again.',

  'lateral-movement': '`apt install python3-impacket enum4linux smbclient` (Kali ships 61 `/usr/bin/impacket-*` tools); for offline cracking `apt install hashcat`.'
    + 'All commands against intranet targets must go through the tunnel: `proxychains4 -f runs/proxychains-<port>.conf ...`; do not modify the system `proxychains` config.',

  'nuclei-scan': '`apt install nuclei`; if the template library `~/.local/nuclei-templates` is missing, run `nuclei -update-templates` (run `' + SETUP + '` is also installed).'
    + 'After updating, first run `nuclei -tl` to confirm the template library is intact; fewer than 1000 templates means the download was incomplete.',

  'passive-recon': 'Depends only on `curl` / `dig` / `jq`: `apt install curl dnsutils jq`; this skill needs no API key.'
    + 'Unavailability usually means a missing skill file or an old plugin version —— reinstall the plugin and restart `dsh web`.',

  'recon-pipeline': 'Fill in the whole toolkit at once: run `' + SETUP + '` (subfinder / dnsx / naabu / httpx / ksubdomain are all inside).\\n'
    + '`~/.local/bin/pd-httpx` is a wrapper script pointing at `toolkit/httpx/httpx`; if missing, rebuild it from `TOOL_FIXES["pd-httpx"]`;'
    + 'If OneForAll cannot be installed the main line is unaffected; use subfinder + ksubdomain instead.',

  'score-coverage': 'A pure lookup skill (identification/entry/evidence for the 25 scoring-item classes) that depends on no external tools and reads no environment variables;'
    + 'Unavailability usually means a missing skill file or an old plugin version —— reinstall the plugin and restart the current host.',

  'specialist-paths': 'A pure reference skill that depends on no external tools and reads no environment variables; unavailability usually means a missing skill file —— '
    + 'Reinstall the plugin and restart the current host. First pick the AD/identity, boundary device, cloud/K8s, IoT/OT, file backup, or AI/Agent path by asset type, then look up the code in score-coverage.',

  'redteam-setup': 'The environment script is at `$DSH_HOME/redteam/setup.sh`; if this file is absent you have the npm build: download from the project GitHub Release '
    + '`dsh-redteam-mode-<version>-toolkit.tar.gz`; after extraction the user performs the README steps themselves.\\n'
    + 'After configuring `FOFA_KEY` and the VPS, restart `dsh web` and write a completion marker: `mkdir -p "$DSH_HOME/redteam" && date -Is > "$DSH_HOME/redteam/.setup-complete"`, then run `redteam_preflight` once more to re-verify.',

  'shell-handler': 'Local listener tools: `apt install netcat-traditional socat tmux` (on the MSF path also `apt install metasploit-framework`).\\n'
    + 'VPS variables are read from `$DSH_HOME/.env`: before commands run `set -a; . "$DSH_HOME/.env"; set +a`; if `REDTEAM_VPS_HOST` is missing, run `' + SETUP + '` to fill in,'
    + 'After changing `.env` you must restart `dsh web`. Always run listeners inside tmux so an SSH disconnect does not take the session with it.',

  'suo5-tunnel': 'Fill in `toolkit/suo5/suo5-linux-amd64`: run `' + SETUP + '` (or take the same-named binary from zema1/suo5 GitHub releases) and `chmod +x`.\\n'
    + 'The tunnel exit/relay depends on the VPS: configure `REDTEAM_VPS_HOST` / `REDTEAM_VPS_KEY` in `$DSH_HOME/.env`, then restart `dsh web`;'
    + 'The tunnel-entry WebShell must be a Behinder/Godzilla shell (see the `webshell-toolkit` skill), otherwise the user cannot reuse it.',

  'unauth-exploit': 'Install clients: `apt install redis-tools default-mysql-client python3-impacket` (use `impacket-mssqlclient` for MSSQL).\\n'
    + 'Intranet targets need a tunnel: after `apt install proxychains4` use `-f runs/proxychains-<port>.conf`, or first set up socks5 per the `suo5-tunnel` skill;'
    + 'When `REDTEAM_VPS_HOST` is unset, VPS-dependent steps are judged unavailable.',

  'vps-reverse-shell': 'Fill in the VPS: run `' + SETUP + '` prompts for `REDTEAM_VPS_HOST` (`user@host`) and `REDTEAM_VPS_KEY` (private key path, defaults to `$DSH_HOME/redteam/toolkit/vps/id_rsa`).\\n'
    + 'You can also write `$DSH_HOME/.env` manually and restart `dsh web`, or edit `$DSH_HOME/skills/vps-reverse-shell.md` directly and replace `<your VPS_IP>` / `<VPS hostname>` with the real address.\\n'
    + 'The private key must be `chmod 600`; verify connectivity with `ssh -i $DSH_HOME/redteam/toolkit/vps/id_rsa -o BatchMode=yes <user>@<ip> \\\'echo ok\\\'`; open ports 22 and 9000-9999 in the security group.',

  'web-fingerprint': 'If `~/.local/bin/pd-httpx` is missing, rebuild it from `TOOL_FIXES["pd-httpx"]` (it execs `toolkit/httpx/httpx`);'
    + 'If `nuclei` is missing, `apt install nuclei`; top up the tech-detection template library with `nuclei -update-templates`.',

  'webshell-toolkit': '`toolkit/Behinder`, `toolkit/Godzilla`, and `toolkit/AntSword` are not in setup.sh, nor in' + TOOLKIT_TARBALL + '：'
    + 'Get them from their own release pages and put them in the corresponding directories.\\n'
    + 'The GUI needs Java and a graphical session: confirm with `java -version` (`apt install openjdk-17-jre` if missing) and `DISPLAY=:10.0`;'
    + 'Without a GUI, swap the key with `sed` to generate the Behinder shell directly (templates in `toolkit/Behinder/server/`).',
}

/* ── 内部工具 ─────────────────────────────────────────────────────────────── */

/** 常见扩展名（`fscan_windows_x64.exe`、`vps.sh`、`godzilla.jar` …）。 */
const EXT_RE = /\.(exe|zip|tar\.gz|tgz|gz|bz2|xz|jar|sh|py|bin|txt|md|json)$/i
/** 平台后缀（`_windows_x64`、`-linux-amd64`、`_darwin_arm64` …）。 */
const PLATFORM_RE = /[-_](windows|win32|win64|win|linux|darwin|macos|osx|freebsd)[-_][a-z0-9_.]+$/
/** 架构后缀（裸的 `_amd64` / `-arm64`）。 */
const ARCH_RE = /[-_](amd64|x86_64|x64|arm64|aarch64|arm|386|i386|i686|mips[a-z0-9]*)$/

/**
 * 把二进制/目录名字清成工具名：剥扩展名、剥平台与架构后缀、转小写。
 * 清完不含 ASCII 字母（例如 `manifest.md`、纯符号）就返回 null —— 那就不是工具名。
 */
function cleanToolName(raw) {
  let out = String(raw == null ? '' : raw).trim()
  if (out === '') return null
  out = out.replace(EXT_RE, '')
  let prev = ''
  while (out !== '' && out !== prev) {
    prev = out
    out = out.replace(PLATFORM_RE, '').replace(ARCH_RE, '')
  }
  out = out.toLowerCase()
  return /[a-z]/.test(out) ? out : null
}

/**
 * 从路径里抽工具名（抽不出来返回 `null`）。
 *   · `…/redteam/toolkit/<tool>/…` → `toolkit/` 之后的第一段目录名（`suo5-linux-amd64` → `suo5`）
 *   · `~/.local/bin/xxx`、`/usr/bin/xxx`、`~/.local/xxx` → 文件名
 *   · 裸名字（`fscan_windows_x64.exe`、`gogo_linux_arm64`）→ 剥平台后缀后的名字
 *   · 其它路径（`/usr/share/wordlists/rockyou.txt`、`skills/x.md`）→ `null`
 */
export function toolNameOfPath(p) {
  if (typeof p !== 'string') return null
  const s = p.trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[，。；、：,;:)\]}>）】]+$/, '')
    .replace(/\\/g, '/')
  if (s === '') return null
  let candidate = null
  const at = s.lastIndexOf('toolkit/')
  if (at !== -1) {
    candidate = s.slice(at + 'toolkit/'.length).split('/').filter((seg) => seg !== '')[0] || null
  } else if (/\/bin\//.test(s) || /(^|\/)\.local\//.test(s)) {
    const segs = s.split('/').filter((seg) => seg !== '')
    candidate = segs.length > 0 ? segs[segs.length - 1] : null
  } else if (!s.includes('/')) {
    candidate = s
  }
  return candidate === null ? null : cleanToolName(candidate)
}

/** 别名的规范化：`impacket-wmiexec` 这类命令归到 `impacket` 这一条修法上。 */
function canonicalTool(name) {
  const n = String(name || '')
  if (n.startsWith('impacket-')) return 'impacket'
  if (n.startsWith('enum4linux-')) return 'enum4linux'
  return n
}

/** 环境变量怎么拿（拿不准的就不编，直接让用户填值）。 */
const ENV_HINTS = {
  FOFA_KEY: 'Log in at <https://fofa.info> → personal center → API Key to get it; a self-test with `curl -s "https://fofa.info/api/v1/info/my?key=$FOFA_KEY"` returning `"error":false` means it is valid',
  REDTEAM_VPS_HOST: 'Fill in the VPS login address `user@host` (e.g. `export REDTEAM_VPS_HOST=ubuntu@203.0.113.10`)',
  REDTEAM_VPS_USER: 'VPS login user (default `ubuntu`)',
  REDTEAM_VPS_KEY: 'Fill in the VPS private key path (default `$DSH_HOME/redteam/toolkit/vps/id_rsa`, permissions must be `chmod 600`)',
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim() !== '')
  if (typeof v === 'string' && v.trim() !== '') return [v]
  return []
}

/**
 * 由 `skill-availability.js` 的判定生成一条中文修复建议。
 *
 * @param issue - `{ kind, skill, paths?, env?, placeholder? }`，
 *   `kind` ∈ `'file-missing' | 'content-missing' | 'env-missing' | 'path-missing' | 'placeholder' | 'shadowed'`。
 *   也接受 `checkSkill()` 返回的 `problems` 之外的补充字段；字段类型宽松（字符串或数组都行）。
 * @returns 一条中文建议（不含换行；命令都在反引号里）。拿不准时回退到 `SKILL_FIXES[skill]`，再回退到通用建议。
 */
export function fixesForIssue(issue) {
  const it = issue && typeof issue === 'object' ? issue : {}
  const kind = typeof it.kind === 'string' ? it.kind : ''
  const skill = typeof it.skill === 'string' ? it.skill : ''
  const skillName = skill === '' ? '<skill name>' : skill
  const skillHint = skill !== '' && Object.prototype.hasOwnProperty.call(SKILL_FIXES, skill) ? SKILL_FIXES[skill] : ''
  const parts = []

  if (kind === 'path-missing') {
    const tools = []
    const seen = new Set()
    for (const p of asArray(it.paths)) {
      const name = toolNameOfPath(p)
      if (name === null) continue
      const canon = canonicalTool(name)
      if (seen.has(canon)) continue          // 同一个工具只列一次
      seen.add(canon)
      tools.push({ name, canon, path: p })
    }
    if (tools.length > 0) {
      const items = tools.map(({ name, canon, path }) => {
        const fix = Object.prototype.hasOwnProperty.call(TOOL_FIXES, canon) ? TOOL_FIXES[canon] : null
        if (fix === null) {
          return '`' + name + '`（' + path + '): this machine does not have this tool, run `' + SETUP + '` to fill in;'
            + 'If it is still missing, download the binary for your platform from the tool\'s official release page, drop it at this path and `chmod +x` it'
        }
        return '`' + name + '`（' + path + '）：' + fix.what + '. Fix: ' + fix.install
      })
      parts.push('missing ' + tools.length + ' tools, fix them one by one:' + items.join('；'))
      parts.push('If unsure, run ` uniformly first' + SETUP + '` (idempotent: missing ones are downloaded, corrupt ones deleted and re-fetched), then run the health check again.')
    }
  } else if (kind === 'env-missing') {
    const names = asArray(it.env)
    if (names.length > 0) {
      const items = names.map((n) => {
        const hint = Object.prototype.hasOwnProperty.call(ENV_HINTS, n) ? ENV_HINTS[n] : 'the value is supplied by you'
        return '`' + n + '`：`export ' + n + '=<value>`（' + hint + '）'
      })
      parts.push('missing environment variable: ' + items.join('；') + '。')
      parts.push('Persistence: write it into `$DSH_HOME/.env` (one `NAME=value` per line, `chmod 600` recommended); after editing you must restart the current `dsh web` process before it is read;'
        + 'or have the user run `' + SETUP + '` (the script walks you through it and validates `FOFA_KEY` and the VPS variables on the spot).')
    }
  } else if (kind === 'placeholder') {
    const ph = typeof it.placeholder === 'string' && it.placeholder.trim() !== '' ? it.placeholder.trim() : 'External infrastructure address'
    parts.push('the skill body says `' + ph + '` is still a placeholder (meaning this environment has no VPS configured).')
    parts.push('Usage: run `' + SETUP + '` walks you through writing `REDTEAM_VPS_HOST` (`user@host`) and `REDTEAM_VPS_KEY` (private key path, default `$DSH_HOME/redteam/toolkit/vps/id_rsa`);'
      + 'You can also write `$DSH_HOME/.env` by hand and restart `dsh web`, or edit `$DSH_HOME/skills/' + skillName + '.md`, replace the placeholders with the real address (remember `chmod 600` for the private key).')
  } else if (kind === 'shadowed') {
    parts.push('The skill is shadowed by a same-named version: `' + skillName + '` also exists in another skill root under the same name (with a fuller configuration),'
      + 'but according to the current skill-root order the incomplete copy listed first is what gets loaded.')
    parts.push('Fix: move the configured skill root to the front of the skill-root order (adjust the order in the plugin/skill directory settings), restart `dsh web` and run the health check again;'
      + 'If you do not need the other copy, delete it or rename it so it cannot shadow this one again.')
  } else if (kind === 'file-stale') {
    parts.push('A file path recorded by a skill does not exist on this machine (the skill body still loads, so calls are unaffected): such paths are absolute paths resolved on some other machine and are guaranteed to point nowhere here.')
    parts.push('Fix: restart `dsh web` once (on startup the plugin syncs the bundled skills to this machine\'s `$DSH_HOME/redteam/skills`);'
      + 'If this machine\'s `DSH_HOME` differs from the directory the host actually uses (drive changed / installed outside the default location), point `DSH_HOME` at the one the host really uses and restart.')
  } else if (kind === 'file-missing') {
    parts.push('Skill file does not exist: reinstall the redteam plugin (or mount the skill directory back into a skill root) to restore the skill files, then restart `dsh web` and run the health check again.')
    parts.push('If it is a skill you placed yourself, make sure the file sits under a skill root and that its filename matches the skill name (`<skill name>.md`).')
  } else if (kind === 'content-missing') {
    parts.push('The skill body cannot be read (metadata only, availability cannot be judged): reinstall the redteam plugin to restore the skill files;'
      + 'If the skill source is remote, confirm it is reachable, pull it again, then restart `dsh web`.')
    parts.push('To check quickly whether it can be used, just have an agent actually load it once with the `skill` tool: `' + skillName + '`。')
  }

  if (parts.length === 0) parts.push(skillHint !== '' ? skillHint : GENERIC_FIX)
  return parts.join(' ')
}
