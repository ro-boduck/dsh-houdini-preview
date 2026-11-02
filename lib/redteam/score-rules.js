/**
 * 计分规则：判定口径 + 默认得分点（零依赖，只用 node: 内置模块）。
 *
 * 从 core.js 抽出来的模块，也是本项目**最该单独读的一份代码**：
 * 面板 / 报告 / 攻击链三处总分必须一致，靠的就是这里的 applyScoreCaps 与
 * evaluateScoreBoard 是**唯一实现** —— 三处各写一遍必然漂移成不同口径。
 *
 * 分工：
 *   · applyScoreCaps       —— 给定命中行，标出哪条计分、哪条被封顶/超上限；
 *   · evaluateScoreBoard   —— 把"Read the metadata + call applyScoreCaps + backfill the flags"包成一个入口；
 *   · DEFAULT_SCORE_POINTS —— 规则文档展开后的得分点定义（src/rule/cap/dedup_scope）。
 */

/* targetHasIpv6Host 要判定 IPv6 字面量：复用 ip-utils 的同一份实现，避免两套正则漂移 */
import { isIpv6 } from './ip-utils.js'

/* ------------------------------------------------------------------ 判定规则 */

/* ------------------------------------------------------------------ 判定规则 */

/**
 * 什么算"Genuine tunnel"（算边界突破/内网突破的凭证）：**必须跨越了靶标边界**，
 * 即通道的一端在目标侧。三种情况：
 *   · target-outbound：目标主动连出到我的服务器（反弹 shell 落地、目标上跑 frp/Stowaway 客户端）
 *   · target-http：经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg、自研 HTTP 隧道）
 *   · target-agent：经目标上已控进程/会话转发的隧道（SSH -R 由目标发起等）
 * 不算的：self-only —— 只在自己 VPS / 自建服务器上开的代理或服务端，没碰到目标。
 */
const TUNNEL_ENTRY_KINDS = {
  'target-outbound': 'The target connects outbound on its own (reverse shell / running an frp client on the target)',
  'target-http': 'Via the target\'s WebShell/HTTP channel (suo5 / Neo-ReGeorg)',
  'target-agent': 'Forwarded via an already-controlled process/session on the target (SSH -R, etc.)',
  'self-only': 'Only on your own VPS/self-hosted server (does not count as a breach)',
}
export { TUNNEL_ENTRY_KINDS }

/** 这条隧道算不算"Crossed the target boundary"。未声明（老数据/没填）返回 null，界面按"To be confirmed"显示。 */
export function tunnelIsLegit(entryKind) {
  const k = String(entryKind || '').trim()
  if (k === '') return null
  return k !== 'self-only'
}

/**
 * 账号/权限类得分点：**自己注册、自己创建的账号不算拿到权限**（演练得分针对"Obtaining something someone else already had"）。
 * 这些得分点命中时会要求声明 self_created，避免把自助注册当成战果。
 */
const ACCOUNT_POINT_CODES = ['web-account-user', 'web-account-admin', 'server-shell', 'db-access', 'internal-pivot', 'core-system']
export { ACCOUNT_POINT_CODES }

/**
 * 按「服务」封顶的得分点：**同一个资产的同一个端口只算一次分**。
 *
 *   · 账号类（web-account-user / web-account-admin）——拿到最高权限账号即该服务拿满：
 *     普通账号 10 分、管理员 20 分，同一服务上再刷几个账号都不再累加
 *     （两种账号算**同一类**：先拿普通账号、后拿管理员，只有管理员那条计分，总分按最高那条算）。
 *   · 数据库类（db-access）——同口径：一个库权限拿满，同服务再刷第二个库账号不重复计分。
 *
 * 其它得分点（webshell/rce/sensitive-data/boundary/…）仍然不设上限，按命中次数累加。
 */
const SERVICE_CAPPED_POINT_CODES = ['web-account-user', 'web-account-admin', 'db-access']
export { SERVICE_CAPPED_POINT_CODES }

/**
 * 从 target 里解析端口：`http://h:8080/x`、`10.0.0.5:6379`、`10.0.0.5:22`。
 * 没有端口或解析不出返回 null（**不要编造 80/443**，否则会把不同服务并成一个）。
 */
export function parseTargetPort(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(t)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const m = /:(\d{1,5})$/.exec(authority)
  if (m === null) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/** 库列的 port 值（老库可能是 null/0/空串）。 */
function normalizePort(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null
}

/**
 * 从 target 里取「服务标识」：host[:port]。
 *   · 端口取显式写的那个；没写就按协议推默认端口（http→80、https→443、其它→不推断），
 *     这样 `http://h/x` 与 `http://h:80/y` 会归到同一个服务；
 *   · 路径/参数/查询串一律丢掉（`http://h:8080/a/b?c=1` → `h:8080`）。
 * 解析不出 host 时返回 null。
 */
function targetAuthority(target) {
  const t = String(target || '').trim()
  if (t === '') return null
  const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]+)/i.exec(t)
  const scheme = url !== null ? url[1].toLowerCase() : null
  const authority = url !== null ? url[2] : (/^([^\s/?#]+)/.exec(t) || [])[1]
  if (!authority) return null
  const host = authority.replace(/:\d{1,5}$/, '').toLowerCase()
  if (host === '') return null
  let port = parseTargetPort(t)
  /* 没写端口时按协议补默认端口：避免同一个服务的两种写法被算成两个服务而被重复计分 */
  if (port === null) {
    if (scheme === 'http') port = 80
    else if (scheme === 'https') port = 443
  }
  return port === null ? host : host + ':' + port
}

/**
 * 「服务」键：得分封顶的粒度 = 同一个资产的同一个端口。
 *   · target 能解析出 host[:port] → 就用它（`t10.20.30.40:3306`）——
 *     同一个服务可能由不同的人记分，有的带 asset_id、有的只写 target，
 *     以目标为准才能把它们归到一起；
 *   · target 解析不出（缺失/只写了名字）→ 退到资产：有端口用 `a<id>:<port>`，
 *     没端口记 `a<id>:0`（该资产的未知端口）；
 *   · 两样都没有 → null（拿不到服务信息，这条不参与封顶）。
 */
export function scoreServiceKey(hit = {}) {
  const authority = targetAuthority(hit.target)
  if (authority !== null) return 't' + authority
  const assetId = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  if (assetId === null) return null
  const port = normalizePort(hit.port)
  return 'a' + assetId + ':' + (port === null ? 0 : port)
}

/** 「服务」的可读标签，给告警/报告用（如 `10.1.2.3:8080`）。 */
export function serviceLabel(hit = {}, assetIp) {
  const ip = assetIp || hit.asset_ip || ''
  const port = normalizePort(hit.port) ?? parseTargetPort(hit.target)
  if (ip !== '') return port === null ? ip : ip + ':' + port
  /* 没有资产 id 时用 target 的 host[:port]（去掉路径与参数，别把整条 URL 当服务名）；
     端口来自库列而 target 里没写时补上，便于一眼看出是哪个服务。 */
  const authority = targetAuthority(hit.target)
  if (authority === null) return hit.target ? String(hit.target) : '(service not labeled)'
  if (port !== null && !/:\d{1,5}$/.test(authority)) return authority + ':' + port
  return authority
}

/**
 * 得分封顶与去重的**唯一实现**（数据驱动，v0.11.0 起）。
 *
 * 判定字段来自得分点本身（`score_point.rule / cap / dedup_scope`），不再靠代码里的硬编码名单：
 *   · `dedup_scope = service` —— 同一（资产, 端口）只算分值最高的一条；
 *   · `dedup_scope = system`  —— 同一（资产, 端口, 系统名）只算最高权限一条，
 *     用于"The same system scores only once at its highest privilege"（邮箱/OA/集权系统等）；
 *   · `dedup_scope = target`  —— 整个目标只算一次（突破网络边界、IPv6 加成）；
 *   · `dedup_scope = none`    —— 不去重，按台/卡/节点数累加（算力卡等）。
 * 之后按 `rule` 分组累计，超过该规则 `cap` 的部分标 `capped`（cap = 0 表示不设上限）。
 *
 * `self_created = 1`（自己注册/自建的账号）本来就不计分，既不参与竞争也不占位。
 *
 * @param {Array} rows - 命中行（需带 code / points / asset_id / port / target / recorded_at；
 *                       可选 system_key 供 system 口径使用）
 * @param {Map|Object|null} pointsByCode - code → `{rule, cap, dedup_scope, points}`；
 *                       省略时退化为"Each code forms its own group; deduplicated only, never capped"（兼容旧调用）
 * @returns {{capped:number, items:Array, caps:Map}} 打过标记的行 + 被封顶条数 + 各规则上限用量
 */
export function applyScoreCaps(rows = [], pointsByCode = null, nameByAsset = null) {
  const metaOf = (r) => {
    const m = pointsByCode === null || pointsByCode === undefined
      ? undefined
      : (typeof pointsByCode.get === 'function' ? pointsByCode.get(r.code) : pointsByCode[r.code])
    const rule = m && m.rule !== null && m.rule !== undefined ? Number(m.rule) : null
    const legacyScope = legacyCapGroup(r.code)
    return {
      group: rule === null ? 'code:' + String(r.code || '') : 'rule:' + rule,
      cap: m && Number(m.cap) > 0 ? Number(m.cap) : 0,
      scope: (m && m.dedup_scope) || legacyScope || 'none',
      rule,
    }
  }
  const flagged = (rows || []).map((r) => {
    const m = metaOf(r)
    return {
      ...r, capped: false, capped_by_id: null, capped_reason_kind: null,
      service_key: null, cap_group: m.group, dedup_scope: m.scope, rule: m.rule, rule_cap: m.cap,
    }
  })

  /* ① 计分口径去重：同一口径键内只保留分值最高的一条（同分取更早记的） */
  const buckets = new Map()
  for (const r of flagged) {
    if (Number(r.self_created) === 1) continue
    const scope = r.dedup_scope
    if (scope === 'none' || scope === null || scope === undefined) continue
    let key
    if (scope === 'target') key = 'target'
    else if (scope === 'system') key = 'sys:' + String(systemKeyOf(r, nameByAsset) || '')
    else {
      /* `service` 口径必须有真正的服务键（`t<host[:port]>` / `a<id>:<port>`）。
         拿不到服务信息时**不参与去重**，而不是退回"Each entry is its own unique key" —— 后者会让
         `svc:#hit7` 这种键把同一口径的命中全部互相顶掉：实测 62 条无 target 的
         terminal-access 命中里 61 条被判 dedup 不计分、只留 1 条，等于静默吃掉成果。
         宁可少封顶也不能错封：认不出服务就各算各的。 */
      const svc = scoreServiceKey(r)
      if (svc === null || svc === undefined || String(svc) === '') continue
      key = 'svc:' + String(svc)
    }
    if (key === '' || key === 'svc:null' || key === 'sys:null') continue
    const k = r.cap_group + '|' + key
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(r)
  }
  let capped = 0
  for (const list of buckets.values()) {
    if (list.length < 2) continue
    const best = pickBestHit(list)
    for (const r of list) {
      if (r === best) continue
      r.capped = true
      r.capped_by_id = best.id
      r.capped_by_points = Number(best.points) || 0
      r.capped_by_evidence = best.evidence || null
      r.capped_reason_kind = 'dedup'
      capped += 1
    }
  }

  /* ② 规则上限：同一 rule 的计分命中累计不得超过 cap（按分值从高到低累计，超出的标 capped） */
  const caps = new Map()
  const byRule = new Map()
  for (const r of flagged) {
    if (r.capped === true || Number(r.self_created) === 1) continue
    if (r.rule_cap <= 0) continue
    if (!byRule.has(r.cap_group)) byRule.set(r.cap_group, [])
    byRule.get(r.cap_group).push(r)
  }
  for (const [group, list] of byRule.entries()) {
    const cap = list[0].rule_cap
    const ordered = [...list].sort((a, b) => {
      const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
      if (pb !== pa) return pb - pa
      return Number(a.id) - Number(b.id)
    })
    let used = 0; let nCapped = 0
    for (const r of ordered) {
      const pts = Number(r.points) || 0
      if (used + pts > cap) {
        r.capped = true
        r.capped_reason_kind = 'cap'
        r.capped_by_points = null
        nCapped += 1
        capped += 1
      } else {
        used += pts
      }
    }
    caps.set(group, { rule: list[0].rule, cap, used, capped: nCapped })
  }
  return { capped, items: flagged, caps }
}

/**
 * 参与 `system` 口径去重的"System key"。
 *
 * 规则原文是"The same system scores only once at its highest privilege"（邮箱、OA、集权系统等）。
 * 判定顺序：
 *   ① 命中自带的 `system_key`（调用方显式指定，最准）；
 *   ② 资产的 `primary_name`（系统名/域名的首选名）；资产名往往是同一套系统，最接近"The same system"；
 *   ③ 退回服务键（资产:端口）。
 * 三条都拿不到返回 null —— 此时**不参与该口径去重**，宁可不封顶也不要错封。
 */
function systemKeyOf(hit = {}, nameByAsset = null) {
  const svc = scoreServiceKey(hit)
  const svcText = svc === null || svc === undefined ? '' : String(svc)

  /* ① 调用方显式给的 system_key：**只有它带上服务键前缀（t<host[:port]> / a<id>:<port>）才采信**。
     调用方（listScorePoints / scoreReport / scoreChain）会预造 `asset name|port` 这种键，
     资产还没有名字时会退化成 `"|8080"` —— 若直接采信，10.7.7.7:8080 与 10.7.7.8:8080
     会被并成"The same system"，把另一台主机的成果白白封顶。
     不能采信时**继续往下走**，用服务键兜底，而不是丢掉整个 system 口径。 */
  const explicit = String(hit.system_key || '').trim()
  if (explicit !== '' && (svcText === '' || explicit.includes(svcText))) {
    /* 没有服务键可校验时，要求"Name field non-empty"（避免只认端口的野键把所有服务并在一起） */
    const head = explicit.split('|')[0]
    if (svcText !== '' || String(head).trim() !== '') return explicit
  }

  /* ② 资产名（系统名/域名首选名）+ 服务键 —— **这是 system 口径的主力路径**。
     规则原文是"The same system scores only once at its highest privilege"，覆盖面是"Same system + same port"：
     同一套系统跑在多台主机、多个端口时是不同实例，各自算一次最高权限。
     ⚠️ 真的需要"Across hosts and ports counts only once"时，应显式给 system_key 并用同一个值
     （见上 ①）——但那时请自己确认这些命中确实是同一个系统实例。 */
  const id = hit.asset_id === null || hit.asset_id === undefined || hit.asset_id === '' ? null : Number(hit.asset_id)
  const nameOf = (assetId) => {
    if (assetId === null || nameByAsset === null || nameByAsset === undefined) return null
    const raw = typeof nameByAsset.get === 'function' ? nameByAsset.get(assetId) : nameByAsset[assetId]
    const text = raw === null || raw === undefined ? '' : String(raw).trim()
    return text === '' ? null : text
  }
  const name = nameOf(id)
  if (name !== null) return name + '|' + svcText

  /* ③ 退到服务键：同（资产, 端口）只算一次最高权限 —— 与 service 口径等效，
     这是"System, application, and database privileges on the same host score only once at the highest privilege"（G1）的兜底。 */
  if (svcText !== '') return svcText

  /* ④ 三条都拿不到（没有 asset_id、没有系统名、target 也解析不出 host）：
     退回**本条命中自己的 id** —— 即"Mutually distinct"，各算各的。
     宁可少封顶也不能错封：把两条无从区分的命中判成"The same system"会白白吃掉用户的成果。
     ⚠️ 这里**不能**用 Math.random()：同一个 hit 在两次调用（面板 / 报告 / 攻击链）里
     会拿到不同的键，计分口径就不稳定了。 */
  return '#hit' + String(hit.id ?? '0')
}

/** 从一组同口径命中里挑"The entry that scores"：分值最高，同分取更早记的（id 小的）。 */
function pickBestHit(list) {
  return list.reduce((a, b) => {
    const pa = Number(a.points) || 0; const pb = Number(b.points) || 0
    if (pb !== pa) return pb > pa ? b : a
    return Number(b.id) < Number(a.id) ? b : a
  }, list[0])
}

/** 旧口径分组（兼容 v0.10 及以前：账号类与数据库类按"Same asset, same port"封顶）。 */
function legacyCapGroup(code) {
  const c = String(code || '').trim()
  if (c === 'web-account-user' || c === 'web-account-admin') return 'service'
  return SERVICE_CAPPED_POINT_CODES.includes(c) ? 'service' : null
}


/**
 * 读取得分点元数据（code → `{ rule, cap, dedup_scope, points, enabled, builtin, src }`）。
 * 面板 / 报告 / 攻击链三处共用，避免"Reading the same rule set three times in three places and missing one field each time"。
 * @param db - 靶标库句柄。
 */
function loadScoreMeta(db) {
  return new Map(db.prepare('SELECT code, rule, cap, dedup_scope, points, enabled, builtin, src FROM score_point')
    .all()
    .map((r) => [String(r.code), {
      rule: r.rule === null || r.rule === undefined ? null : Number(r.rule),
      cap: Number(r.cap) || 0,
      dedup_scope: r.dedup_scope || 'service',
      points: Number(r.points) || 0,
      enabled: r.enabled === null || r.enabled === undefined ? 1 : Number(r.enabled),
      builtin: Number(r.builtin) === 1,
      src: r.src === null || r.src === undefined ? null : Number(r.src),
    }]))
}

/**
 * 资产 id → 系统名（primary_name），`system` 口径要用它把"The same set of systems"归到一起。
 * @param db - 靶标库句柄。
 */
function loadAssetNames(db) {
  return new Map(db.prepare('SELECT id, primary_name FROM asset').all()
    .filter((a) => a.primary_name).map((a) => [Number(a.id), a.primary_name]))
}

/**
 * 本条命中的**实际分值** = 档位分值 × 倍率。
 *   · 档位分值：命中自带优先（合并版同一条含多档），缺省回落到得分点默认分值；
 *   · 倍率：G5 数据规模翻倍（超 1 亿条 / 10TB，或控制知识库相关系统）×2、
 *     G6 IPv6 成果 ×3。倍率作用在**权限分**上，所以乘在分值里、随上限一起被 cap 约束
 *     （文档要求"Caps remain the original caps for the corresponding system type; the multiplier does not break the cap"）。
 */
function hitPointsOf(hit = {}, metaByCode = null) {
  let base = 0
  if (hit.points !== null && hit.points !== undefined && hit.points !== '') {
    base = Number(hit.points) || 0
  } else {
    const code = hit.code === null || hit.code === undefined ? null : String(hit.code)
    if (code !== null && metaByCode !== null && metaByCode !== undefined) {
      const meta = typeof metaByCode.get === 'function' ? metaByCode.get(code) : metaByCode[code]
      if (meta !== undefined && meta !== null) base = Number(meta.points) || 0
    }
  }
  const mult = Number(hit.multiplier)
  return Math.round(base * (Number.isFinite(mult) && mult > 0 ? mult : 1))
}

/**
 * 这个 target 的主机部分是 IPv6 字面量吗（http://[2001:db8::1]:8080/x、2001:db8::1、[::1]:22）。
 *
 * 不能用一条粗糙的字符类正则代替：IPv6 里混着十六进制字母（a-f），
 * 写成 /^\[[0-9a-f:]+\]/ 这类"Look only at the colon and the hex digits"的写法会把带字母的地址漏判
 * （实测 2001:db8::1 里的 db8 就被漏掉，G6 的 ×3 完全不生效）。
 * 所以把主机部分交给 isIpv6() 判定 —— 与 cidrOf / scopeOfIp 用同一份实现。
 */
function targetHasIpv6Host(target) {
  const text = String(target || "").trim()
  if (text === "") return false
  const bracket = /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\])/i.exec(text)
  if (bracket !== null) return isIpv6(bracket[1].replace(/^\[|\]$/g, ""))
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(text)
  const authority = url !== null ? url[1] : (/^([^\s/?#]+)/.exec(text) || [])[1]
  if (!authority) return false
  /* 裸写 IPv6 想带端口必须加方括号，所以这里去掉方括号后再尝试剥端口 */
  const host = authority.replace(/^\[|\]$/g, "").replace(/:\d{1,5}$/, "")
  return isIpv6(host)
}

/**
 * 把 G5 / G6 的倍率规则算成倍率值（只对权限分生效，且不突破原上限 —— 由 cap 兜住）。
 *   · `ip_version === 6` 或 target 是 IPv6 字面量 → ×3（G6）；
 *   · `data_scale === "large"` → ×2（G5：超 1 亿条 或 10TB）；
 *   · `data_scale === "knowledge-base"` → ×2（G5：控制知识库相关系统）；
 *   · 两者都命中 → 相乘。文档没写禁止叠加，取对演练方有利的解释并**如实标注原因**。
 * @param hit - 命中参数（ip_version / data_scale / target）。
 * @returns `{ multiplier, reasons }`
 */
function scoreMultiplierOf(hit = {}) {
  const reasons = []
  let multiplier = 1
  const target = String(hit.target || "")
  const ipv6 = Number(hit.ip_version) === 6 || targetHasIpv6Host(target)
    /* 裸写 IPv6 兜底的正则必须含 ≥2 个冒号：dc01:389 / ad01:8080 这类内网主机名:端口
       只有一个冒号，旧正则会把它们误判成 IPv6 让成果静默 ×3 */
    || /(^|\/\/)(?:\[[0-9a-f:]+\]|[0-9a-f]*(?::[0-9a-f]*){2,})/i.test(target)
  if (ipv6) { multiplier *= 3; reasons.push("G6 IPv6 findings ×3") }
  const scale = String(hit.data_scale || "").trim().toLowerCase()
  if (scale === "large") { multiplier *= 2; reasons.push("G5 data scale over 100 million records / 10TB ×2") }
  else if (scale === "knowledge-base" || scale === "kb") { multiplier *= 2; reasons.push("G5 controlling knowledge-base-related systems ×2") }
  return { multiplier, reasons }
}

/**
 * **统一的计分评估**：面板 / 报告 / 攻击链都调这一个函数算出"Which one scores and which one is capped"。
 *
 * 输入为一组"Hit line"，输出它们的计分标记。调用方只需保证每行带
 * `{ id, code, points, asset_id, port, target, self_created }` 与**本条命中的实际分值**
 * （`points` 字段；不要传得分点默认值 —— 合并版里同一条含多档，传默认值会把哪条计分判反）。
 *
 * @param db - 靶标库句柄。
 * @param rows - 命中行数组。
 * @param options - `{ meta?, names?, enabledOnly? }`：可复用已读好的元数据；`enabledOnly` 为 true
 *                  时"Disabled scoring item"的命中直接标为不计分（报告与面板口径必须一致）。
 * @returns `{ byId, items, caps, meta, names, disabledIds }`
 */
function evaluateScoreBoard(db, rows = [], options = {}) {
  const meta = options.meta || loadScoreMeta(db)
  const names = options.names || loadAssetNames(db)
  const prepared = (rows || []).map((h) => {
    const code = h.code === null || h.code === undefined ? null : String(h.code)
    const m = code === null ? undefined : meta.get(code)
    const nm = h.asset_id === null || h.asset_id === undefined ? null : names.get(Number(h.asset_id))
    return Object.assign({}, h, {
      code,
      /* points 必须是"The actual points of this hit"（见上方说明）：调用方传进来的已经乘过倍率，
         这里不能再乘一次，否则 G5/G6 的 ×2/×3 会变成 ×4/×9（合法命中还会被顶上限判成 0 分）。
         只有没传 points 的行才回落到 hitPointsOf 现算。 */
      points: (h.points !== null && h.points !== undefined && h.points !== '')
        ? (Number(h.points) || 0)
        : hitPointsOf(h, meta),
      rule: m === undefined || m.rule === undefined ? null : m.rule,
      cap: m === undefined ? 0 : m.cap,
      dedup_scope: m === undefined ? 'service' : m.dedup_scope,
      cap_group: m === undefined || m.rule === null || m.rule === undefined ? 'code:' + String(code) : 'rule:' + m.rule,
      rule_cap: m === undefined ? 0 : m.cap,
      system_key: [nm || '', normalizePort(h.port) ?? parseTargetPort(h.target) ?? ''].join('|'),
    })
  })
  const evaluated = applyScoreCaps(prepared, meta, names)
  const byId = new Map(evaluated.items.map((x) => [x.id, x]))
  const disabledIds = new Set()
  if (options.enabledOnly === true) {
    for (const h of prepared) {
      const m = h.code === null ? undefined : meta.get(h.code)
      if (m !== undefined && Number(m.enabled) !== 1) disabledIds.add(h.id)
    }
  }
  return { byId, items: evaluated.items, caps: evaluated.caps, meta, names, disabledIds }
}

/**
 * 这条命中为什么不计分（告警 / 界面 / 报告共用一句话，避免三处口径写歪）。
 * @param hit - 命中行（带 code / target / port / rule / rule_cap / capped_reason_kind）
 * @param bestPoints - 去重时被哪条压住（该条的分值）
 */
export function scoreCapReasonText(hit = {}, bestPoints) {
  const label = serviceLabel(hit)
  if (hit.capped_reason_kind === 'cap') {
    return '「' + label + '" this entry does not score:'
      + (hit.rule === null || hit.rule === undefined ? '' : 'Rule ' + hit.rule + ' ')
      + '\'s **cumulative score has reached this rule\'s cap (' + (Number(hit.rule_cap) || 0) + ' points)**——the portion exceeding the cap for the same rule no longer accumulates.'
      + 'Shift effort to other rules or other assets; do not keep farming a rule that has already reached its cap.'
  }
  return '「' + label + '" the privileges on this target are already maxed out (scoring standard: for the same target only the highest-scoring entry counts'
    + (bestPoints === undefined || bestPoints === null ? '' : '，+' + bestPoints + ' points')
    + ')——this no longer scores under the rules and only stays as a process trace; **switch to another target or another rule, do not farm the same class of findings on one target**.'
}

/** 兼容旧名（v0.10 及以前叫 serviceCapReason）。 */
export const serviceCapReason = scoreCapReasonText


/**
 * 数据规模的**粗判门槛**：100 万条/行。
 * 用途已经从「大量敏感信息得分项」改成 G5 翻倍的量级自检 —— 见 addScoreHit 里的警告。
 * 文档里 G5 的正式门槛是「超 1 亿条 或 10TB」；这里用更低的一档做"Whether the magnitude is stated"的粗筛，
 * 低于它会提示核对，但不阻断记分。
 */
export const SENSITIVE_DATA_MIN_ROWS = 1000000

/**
 * 从证据文本里解析数据量（行/条/记录数）。
 * 支持「120 万条」「1300万行」「1,200,000 条记录」「2.5万行」「1200000 records」。
 * **只认带量词（条/行/记录/records/rows）或中文量级（亿/万…）的写法**——
 * 裸数字不认，否则会把口令里的 `123456`、端口号当成数据量。
 * 解析不出来返回 null（由调用方提示补齐量级，不猜、不编数）。
 */
export function parseRowCount(evidence) {
  const text = String(evidence || '')
  if (text.trim() === '') return null
  const units = { 亿: 1e8, 千万: 1e7, 百万: 1e6, 十万: 1e5, 万: 1e4, 千: 1e3 }
  const nums = []
  /* 「数字 + 单位 + 条/行/记录」：单位是中文量词，或英文 records/rows/entries */
  const cn = /(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)?\s*(条|行|记录|数据|records?|rows?|entries)/gi
  for (const m of text.matchAll(cn)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (!Number.isFinite(base)) continue
    const mult = m[2] === undefined ? 1 : units[m[2]]
    nums.push(Math.round(base * mult))
  }
  if (nums.length > 0) return Math.max(...nums)
  /* 只写了「导出 120 万」这类（没写条/行）也认，但必须带中文量级 */
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(亿|千万|百万|十万|万|千)/g)) {
    const base = Number(String(m[1]).replace(/,/g, ''))
    if (Number.isFinite(base)) nums.push(Math.round(base * units[m[2]]))
  }
  return nums.length === 0 ? null : Math.max(...nums)
}

/** 千分位展示，告警里读数更直观。 */
export function formatRows(n) {
  return Number(n).toLocaleString('en-US')
}


/* ------------------------------------------------------------------ 默认得分点 */

/**
 * 得分点 → 交付口径（怎么算拿到、拿什么自证、怎么复现）。
 *
 * 为什么单独一张表而不是塞进 `score_point.description`：
 * 描述是"Clause of the rule document"（给智能体判档位用），这张表是"The reproduction standard shown to the acceptor"，
 * 两者受众不同、详略也不同。报告与界面按 code 取这里的说明，
 * 规则文档更新时不必动这张表，反之亦然。
 *
 * 字段：
 *   · need   —— 判定标准：满足什么才算拿到这一项（给验收人对账用）
 *   · proof  —— 自证材料：该附什么证据（G7 的证明材料要求）
 *   · replay —— 复现入口：用哪条请求 / 哪条命令重放（"Reproducible"最直接的答案）
 *   · script —— 一线可直接照做的动作（尽量是可复制执行的）
 */
export const SCORE_CONFIRM = {
  'domain-control': {
    need: 'The target domain\'s resolution records are changed to our control (NS/A records take effect), or the domain management console is operable',
    proof: 'Management console screenshots + a dig/nslookup comparison before and after the record change',
    replay: 'nslookup <domain> <our NS>; or the raw request of the console operation',
    script: 'dig NS <domain> @8.8.8.8\\ndig <domain> @<our NS>',
  },
  'terminal-access': {
    need: 'Able to issue commands to terminals and retrieve execution results (not merely "discovered a device")',
    proof: 'Output of id/hostname executed on the controlled terminal + proof of its relationship to the target organization (G7)',
    replay: 'Running id inside the remote-control session; or the agent check-in record of the trojan/remote control',
    script: 'id; whoami; hostname',
  },
  'server-host': {
    need: 'A command was executed on the host with output returned (WebShell / reverse shell / remote control all count)',
    proof: 'Command output (id / hostname) + WebShell connection details or session record',
    replay: 'Raw WebShell request (directly replayable); or the listener log of the reverse shell',
    script: 'id; uname -a; cat /etc/passwd | head',
  },
  'db-credential': {
    need: 'Connected to the database with an account and executed a query (unauthorized access counts too: being able to connect is enough)',
    proof: 'Query output after a successful login (select user(), version()) + the account\'s privilege level',
    replay: 'mysql -h <host> -P <port> -u <user> -p\'<pass>\' -e "select user(),version()"',
    script: 'mysql -h <host> -u <user> -p -e "select user(),version(),current_user()"',
  },
  'web-app': {
    need: 'Logging into the system with an existing target account (ordinary or admin) and accessing a protected page',
    proof: 'Post-login page content/output + session Cookie or Token (proving it is not merely a password)',
    replay: 'Raw login request (including the Cookie/Token obtained) + one session-bearing request to a protected page',
    script: 'curl -i -s -X POST <login URL> -d "username=<u>&password=<p>" -c cookie.txt\\ncurl -s -b cookie.txt <protected page>',
  },
  'central-system': {
    need: 'Logging into a centralized system such as a bastion host / domain controller / SSO / terminal management console and obtaining admin privileges',
    proof: 'Screenshots of the management console + an operation showing "managed subordinate nodes can be controlled" (log in to 20% of managed nodes or 20 machines)',
    replay: 'Raw login request + the request and response of one control operation (e.g. listing managed hosts)',
    script: 'curl -s -b cookie.txt "<control list endpoint>"',
  },
  'bigdata-system': {
    need: 'Obtaining admin or ordinary privileges on big-data platforms (Hadoop/Spark/ES, etc.)',
    proof: 'Platform management page/API output + the accessible data scale (record count or capacity)',
    replay: 'Raw platform API request (e.g. ES _cat/indices, YARN /ws/v1/cluster/apps)',
    script: 'curl -s "<platform API>" | head -50',
  },
  netdev: {
    need: 'Logging into a network device (firewall/router/switch/VPN/gateway) and obtaining privileges',
    proof: 'Device management page screenshots + routing table or connection-volume screenshots (explicitly required by G7)',
    replay: 'Raw device login request + the command output reading the routing table',
    script: 'show ip route    # or display ip routing-table',
  },
  'netdev-redirect': {
    need: 'Using that device actually changed traffic flow (policy/route/DNS changes took effect)',
    proof: 'Before/after comparison of routing tables or policies + evidence that our node received the traffic',
    replay: 'Raw policy configuration request + packet capture/access logs on our controlled node',
    script: 'tcpdump -ni any port <port> -c 10',
  },
  'netdev-implant': {
    need: 'An executable remote-control/persistence implant is on the device, **and** follow-on attacks were completed through it',
    proof: 'Evidence of the remote-control process or persistence entry + records of follow-on findings launched through that device',
    replay: 'Raw request/command of the implantation + subsequent access logs through that device',
    script: '',
  },
  iiot: {
    need: 'Obtaining admin privileges on industrial internet systems, or batch-controlling the interconnected devices under them',
    proof: 'Management console screenshots + list and count of controlled devices',
    replay: 'Raw login request + device-list API response',
    script: '',
  },
  'cloud-platform': {
    need: 'Admin privileges on the cloud management platform; or batch control of cloud nodes via ak/sk (node points count only at ≥100)',
    proof: 'Screenshots of the platform management page; for ak/sk scenarios provide the list and count of controlled nodes, or proof of admin rights (adding nodes / changing permissions)',
    replay: 'Raw platform API request (listing instances, creating users, etc.)',
    script: 'curl -s -H "Authorization: Bearer <token>" "<platform/instance list endpoint>"',
  },
  'iot-platform': {
    need: 'Obtaining privileges on an IoT control platform, or batch-controlling devices by its connection points',
    proof: 'Platform management page screenshots + number of connection points/devices',
    replay: 'Raw platform login and device-list API requests',
    script: '',
  },
  'iot-corenet': {
    need: 'Lateral movement from an IoT endpoint device into the core network, with control of important systems such as business production',
    proof: 'Path description (which endpoint→core network→which system) + evidence of control over that system',
    replay: 'The lateral-action command issued from the endpoint + login/operation requests to core-network systems',
    script: '',
  },
  secdev: {
    need: 'Obtaining admin privileges on non-centralized security devices (IPS/IDS/audit/WAF)',
    proof: 'Device management page screenshots + an operation showing policy control',
    replay: 'Raw login request + one policy-read API response',
    script: '',
  },
  'file-storage': {
    need: 'Obtaining back-office privileges on a file storage system (FTP/NAS/cloud drive/object storage), or obtaining an ordinary account on it',
    proof: 'Directory listing screenshots + list of readable files (data findings score separately, see G2)',
    replay: 'Raw request listing a directory (FTP LIST / S3 ListObjects / WebDAV PROPFIND)',
    script: 'curl -s "<storage API>" | head -50',
  },
  'ai-agent': {
    need: 'Control of a model agent / skill or another agent tool, **and actually driving it to perform an action**',
    proof: 'Conversation or call logs + the actions it was driven to perform and their results (the range score is assessed by depth of control)',
    replay: 'Raw request that drove the agent + output of the action it performed',
    script: '',
  },
  'model-compute': {
    need: 'Obtaining system admin privileges on the compute management platform / training-data and knowledge-base systems',
    proof: 'Management console screenshots + an operation showing compute scheduling or readable/writable data',
    replay: 'Raw platform login and scheduling/data API requests',
    script: '',
  },
  'model-data': {
    need: 'Obtaining admin privileges on model-related data systems (able to affect training/inference/operations or steal or tamper with weights)',
    proof: 'Management console screenshots + list of readable/writable models/datasets',
    replay: 'Raw platform API request (listing models, downloading weights)',
    script: '',
  },
  'computepower-admin': {
    need: 'Obtaining compute infrastructure admin privileges',
    proof: 'Management console screenshots + proof of schedulable resources',
    replay: 'Raw platform login and resource-list API requests',
    script: '',
  },
  'computepower-cards': {
    need: 'Actually obtaining compute-card resources (10 points per card) or control of a card-pooling platform',
    proof: 'Card resource list (quantity) + evidence of being able to submit jobs or exclusively occupy cards',
    replay: 'nvidia-smi output / platform card-list API',
    script: 'nvidia-smi -L',
  },
  'boundary-logical': {
    need: 'A channel to the intranet was established from the target side, and intranet targets can be **actually accessed**',
    proof: 'Tunnel registration (the entry must be on the target side) + output/screenshots of accessing intranet targets through the tunnel (G7)',
    replay: 'The command that accessed the intranet target through the tunnel and its output; the tunnel setup command',
    script: 'curl --socks5-hostname 127.0.0.1:<port> http://<intranet IP>/ -i',
  },
  'boundary-strong': {
    need: 'Breaching gateway-type strong isolation, entering the strongly isolated business intranet, and actually reaching intranet targets',
    proof: 'Screenshots of control over gateway-type isolation devices + proof of intranet access (G7)',
    replay: 'The command accessing intranet targets through the strong-isolation channel and its output',
    script: '',
  },
  'boundary-physical': {
    need: 'Breaching physical isolation / entering the core production network and actually reaching the target',
    proof: 'Screenshots of control over firewall/VPN/multi-NIC host/gateway + screenshots showing intranet access (G7)',
    replay: 'The command accessing the target after entering the core network and its output',
    script: '',
  },
  'boundary-supply': {
    need: 'Entering a primary-defense organization\'s intranet via a supply-chain operations channel or cloud service (scored separately by scenario)',
    proof: 'Evidence of control on the supply-chain/cloud side + proof of entering the primary-defense organization\'s intranet; state which scenario applies',
    replay: 'The command entering the intranet from the supply-chain channel and its output',
    script: '',
  },
}

/** 取某个得分点的交付口径；没有专门条目时返回 null（报告会退回只显示 evidence）。 */
export function scoreConfirmOf(code) {
  const key = String(code || '').trim()
  return SCORE_CONFIRM[key] === undefined ? null : SCORE_CONFIRM[key]
}

export const DEDUP_SCOPES = ['service', 'system', 'target', 'none']

/**
 * 一条得分点的完整定义（工厂函数，避免 22 个对象重复字段）。
 *
 * 两个编号各司其职，**不要混用**：
 *   · `src`  —— 《突破入侵类得分规则（合并版）》里的"Original number"（合并行写首个原序号），
 *               只用于与原表逐条对账，出现在文档与代码注释里；
 *   · `rule` —— 本实现内部的**上限分组键**（`applyScoreCaps` 按它累计 cap）。
 *               它必须**唯一**：历史上曾直接用原序号当分组键，导致 16/17 合并行与
 *               19 的两个子项共用同一个键 —— 一条命中会把另一条的上限吃掉，
 *               而且 `rule` 编号出现重复（两个 19）与空号（6/17/20/21），
 *               模型读到"Rule 19 has reached its cap"时分不清是哪一条。
 *               现在统一为 1..N 连续唯一，与数组顺序一一对应。
 */
const sp = (src, rule, tier, code, name, category, points, cap, dedup_scope, description) => ({
  src, rule, tier, code, name, category, points, cap, dedup_scope, description,
})

/* ── 通用规则（G1–G8，横切全部条目；不单独计分，写进说明与提示词）────────────
   G1 权限取高只计一次 ｜ G2 数据成果另行计分 ｜ G3 上限针对单个防守单位 ｜
   G4 设备按台（个）计分 ｜ G5 数据规模翻倍 ｜ G6 IPv6 ×3（不突破原上限）｜
   G7 证明材料要求 ｜ G8 兜底：其他系统由专项组研判后给分。
   完整原文见 docs/得分规则-合并版.md。 */
export const SCORE_GENERAL_RULES = [
  { code: 'G1', name: 'Privileges taken at the highest, counted once only', detail: 'When multiple privilege levels are obtained on the same system, same host, or same database, score only once at the highest privilege (holding both admin and ordinary privileges scores only the admin privilege points).' },
  { code: 'G2', name: 'Data findings scored separately', detail: 'Mail data, business data, data assets and similar findings score separately by data importance and are never mixed with privilege points.' },
  { code: 'G3', name: 'Cap standard', detail: 'Each points cap applies to a single defending unit and all its subordinate bodies; once the cap is reached, nothing further accumulates.' },
  { code: 'G4', name: 'Devices/terminals scored per unit', detail: 'Printers and wifi routers 5 points each; PCs, Pads, phones, cameras, electronic displays 10 points each; cloud hosts, containers, managed interconnected devices, IoT connection points, etc. counted at 10 points per unit (each). Batch control is converted by "controlled nodes".' },
  { code: 'G5', name: 'Data-scale doubling', detail: 'Covers large-data systems (important data exceeding 100 million records or 10TB) whose score doubles; controlling knowledge-base-related systems also doubles the score. Ordinary log data generated by systems is excluded.' },
  { code: 'G6', name: 'IPv6 multiplier', detail: 'Findings obtained via IPv6 score ×3, but caps are still the original caps for the corresponding system type; the multiplier does not break the cap.' },
  { code: 'G7', name: 'Proof materials', detail: 'Breaching the network boundary requires screenshots of control over isolation devices, proof of intranet access, etc.; controlled terminals such as phones and Pads must be shown to belong to the target organization; network device privileges require evidence such as routing tables or connection-volume screenshots.' },
  { code: 'G8', name: 'Fallback clause', detail: 'Privileges on other systems, servers, devices, etc. carry no preset points and are scored by the specialist team after assessment.' },
]

/**
 * 默认得分点 —— **严格对齐《突破入侵类得分规则（合并版）》，共 25 项**
 * （一、获取权限 21 条 + 二、突破网络边界 4 条，共 8 个类别；其中"Different billing units on the same line"拆为独立得分点，如算力基础设施的管理员权限与算力卡）。
 *
 * 与上一版的区别：不再按"Privilege tiers within the same rule"拆条 —— 一条 = 合并版里的一行
 * （`tier` 字段写清该条的档位/子项），只有**计费单位不同**的多档才保留子项
 * （如算力基础设施的"Admin privileges"与"Compute cards 10 points per card"）。
 *
 * 字段含义：
 *   · src    合并版里的"Original number"（用于与原表逐条对账）；
 *   · group  界面分组：GENERAL = 控制一般系统，WEB = 控制 Web 应用系统，
 *            CENTRAL = 控制集权系统，BIGDATA = 控制大数据系统，
 *            NETINFRA = 控制网络基础设施，STORAGE = 文件存储类系统，
 *            MODEL = 控制模型相关系统，BOUNDARY = 突破网络边界；
 *   · points 单次分值（一条内多档时取该条的主档，说明里写清各档）；
 *   · cap    该条上限（0 = 不设上限）；dedup_scope 计分口径。
 */
export const SCORE_GROUPS = [
  { code: 'GENERAL', name: 'Control of general systems' },
  { code: 'WEB', name: 'Control of web application systems' },
  { code: 'CENTRAL', name: 'Control of centralized systems' },
  { code: 'BIGDATA', name: 'Control of big-data systems' },
  { code: 'NETINFRA', name: 'Control of network infrastructure' },
  { code: 'STORAGE', name: 'File storage systems' },
  { code: 'MODEL', name: 'Control of model-related systems' },
  { code: 'BOUNDARY', name: 'Breaching the network boundary' },
]

export const DEFAULT_SCORE_POINTS = [
  /* ══ 一、获取权限（18 条）══════════════════════════════════════════════ */

  /* 1 域名控制权限 */
  sp(1, 1, 'Top-level 50 / second-level 20 points each', 'domain-control', 'Domain control privileges', 'GENERAL', 50, 400, 'system',
    '**Top-level domains 50 points each, second-level domains 20 points each**, scored by domain type; this item is capped at 400 points (G3).\\n'
    + 'When scoring, state the domain and its type in evidence; for second-level domains adjust the per-hit points to 20.'),

  /* 2 终端权限 */
  sp(2, 2, '5 / 10 points each', 'terminal-access', 'Terminal privileges (phones, Pads, PCs, printers, cameras, wifi routers, etc.)', 'GENERAL', 10, 600, 'system',
    '**Printers and wifi routers 5 points each; PCs, Pads, phones, cameras, electronic displays 10 points each** (G4), accumulated per unit; this item is capped at 600 points (G3).\\n'
    + 'Controlled terminal devices must be shown to belong to the target organization (G7); for devices in the 5-point tier, adjust the per-hit points to 5.\\n'
    + 'Terminals obtained through phishing also score under this item; state the target person\'s role in evidence (general office / IT operations / business operations).'),

  /* 3 服务器主机权限 */
  sp(3, 3, 'Ordinary 10 / admin 50 points each', 'server-host', 'Server host privileges (including webshell privileges)', 'GENERAL', 50, 600, 'system',
    '**Ordinary privileges 10 points each, admin privileges 50 points each**; this item is capped at 600 points (G3).\\n'
    + 'The same host scores only once at the highest privilege (G1)——after root/SYSTEM, no further ordinary-privilege points accumulate on that host.\\n'
    + 'Obtaining a single server host incurs no deduction; when only ordinary privileges are obtained, adjust the per-hit points to 10.'),

  /* 4 数据库连接账号密码 */
  sp(4, 4, 'Ordinary 10 / admin 50 / unauthorized 10 points each', 'db-credential', 'Database connection account and password (including via SQL injection)', 'GENERAL', 50, 400, 'system',
    '**Ordinary user privileges 10 points each, admin privileges 50 points each; redis and other blank-password or unauthorized-access findings score a flat 10 points each**; this item is capped at 400 points (G3).\\n'
    + 'Equal-level privileges on the same database (including admin) score only once; system, application, and database privileges on the same host score only once at the highest privilege (G1).\\n'
    + 'Data findings score separately (G2); when only ordinary privileges / unauthorized access are obtained, adjust the per-hit points to 10.'),

  /* 5、6 邮箱与业务生产系统（原表两项共用规则与上限） */
  sp(5, 5, 'Admin 100 / ordinary 50 points each', 'web-app', 'Mail system / office automation and business production systems / other web application system privileges', 'WEB', 100, 2000, 'system',
    '**Admin privileges 100 points each, ordinary user privileges 50 points each; the same system counts only once at its highest privilege level** (G1); this item is capped at 2000 points (G3).\\n'
    + 'This item merges items 5 and 6 of the original table (identical rules and caps), **i.e. the "control of web application systems" category**; when scoring, state in evidence which kind of system it is:\\n'
    + '· **Mail system**;\\n'
    + '· **Office automation and business production systems** (office OA, ERP, direct-report instant messaging, finance systems, business production systems, data warehouses, and other systems whose compromise or outage affects industry or unit business production, operations management, or daily office work);\\n'
    + '· **Other web application systems (fallback category)**: HTTP/HTTPS sites you can **actually log in to** with the accounts in the credential list,'
    + 'Anything not falling into a more specific scoring category (centralized systems go to item 7, big-data systems to item 8, cloud management platforms to item 11, IoT control platforms to item 12, security devices to item 13, etc.)'
    + 'Scored uniformly under this item (admin 100 / ordinary 50). **Web logins whose credentials record only `host:port`, with no system name or business owner (back office, admin console, operations platform, in-house business systems, etc.), also fall under this rule**——'
    + 'First decide whether a more apt category applies; if not, classify it as "control of web application systems" and do not omit it just because "it is unclear whether it is mail/OA".'
    + 'When scoring, write the actual login URL (with port) in `target`, state clearly in evidence "which site + which account + admin/ordinary tier", and test the login for real first per red line one.\\n'
    + 'Mail data scores separately again by importance (G2); when only ordinary user privileges are obtained, adjust the per-hit points to 50.'),

  /* 7 集权系统 */
  sp(7, 6, 'Admin 500 / ordinary 50 points each', 'central-system', 'Centralized system privileges (operations / identity / networking / terminal management consoles)', 'CENTRAL', 500, 4000, 'system',
    '**System administrator privileges 500 points each, ordinary privileges 50 points each**; each privilege level scores only once, i.e. holding both admin and ordinary privileges scores only the admin privilege points (G1); this item is capped at 4000 points (G3).\\n'
    + 'Centralized systems fall into four categories:\\n'
    + '· **Operations-centralization category**: bastion hosts, centralized monitoring, unified resource publishing, etc.;\\n'
    + '· **Identity and privilege management category**: SSO, 4A, IAM, etc.;\\n'
    + '· **Network-centralization category**: domain controllers, certificate authorities, SD-WAN unified controllers, etc.;\\n'
    + '· **Terminal host management console category**: terminal management software consoles, zero-trust control centers, etc.\\n'
    + '⚠️ Hosts, terminals, and other devices **managed by a centralized system reference the "control of general systems" points across categories** (e.g. PCs and mobile terminals at 10 points each, G4)——'
    + '**Do not score this at the centralized-system top tier of 500 points**, that would be badly inflated; batch control requires proof: log in to at least 20% of the managed nodes, and logging in to 20 machines at most is enough.'),

  /* 8 大数据系统 */
  sp(8, 7, 'Admin 1000 / ordinary 100 points each', 'bigdata-system', 'Big-data system privileges', 'BIGDATA', 1000, 4000, 'system',
    '**Admin privileges 1000 points, ordinary privileges 100 points each**; each privilege level scores only once, so holding both admin and ordinary privileges scores only the admin privilege points (G1); this item is capped at 4000 points (G3).\\n'
    + 'Data scores separately (G2); **effective data volume below 500 million records or 1TB is treated as an ordinary database** (i.e. use the item 4 points instead).'),

  /* 9 网络设备权限 */
  sp(9, 8, 'Ordinary 100 / admin 200 / bonus 200·1000 points', 'netdev', 'Network device privileges (firewalls, routers, switches, gateways, optical gateways, ferry machines, VPNs, etc.)', 'NETINFRA', 200, 2000, 'service',
    '**Ordinary user privileges 100 points, admin privileges 200 points**; this item is capped at 2000 points (G3). Requires evidence such as routing tables or connection-volume screenshots (G7).\\n'
    + 'Performing the following actions on the same device **adds further points** (score the tier actually achieved):\\n'
    + '· Using that device for **network redirection or business hijacking**: +200 points;\\n'
    + '· **Implanting a remote-control program on the device and successfully conducting follow-on attacks**: 1000 points.\\n'
    + 'When only ordinary privileges or bonus points are obtained, adjust the per-hit points to the actual tier.'),

  /* 10 工业互联网系统 */
  sp(10, 9, 'Admin 200 / devices 10 points each', 'iiot', 'Industrial internet system privileges', 'NETINFRA', 200, 2000, 'system',
    '**Admin privileges on the management console 200 points; managed interconnected devices 10 points each** (G4); this item is capped at 2000 points (G3).\\n'
    + 'Covers connected vehicles, smart manufacturing, remote diagnostics, intelligent transportation, etc. When accumulating devices individually, use a separate hit record (points set to 10).'),

  /* 11 云管理平台 */
  sp(11, 10, 'Admin 500 / nodes 10 points each', 'cloud-platform', 'Control of the cloud management platform (including PaaS clouds such as K8S, Red Hat OpenShift, etc.)', 'NETINFRA', 500, 2000, 'system',
    '**Admin privileges 500 points; cloud hosts and containers 10 points each** (G4); this item is capped at 2000 points (G3). Cloud business systems score separately under the important-system rules.\\n'
    + 'Batch control via ak/sk by default **counts only controlled-node points, not admin points**, unless proof of admin privileges is provided (e.g. adding cloud nodes, user permission management).\\n'
    + '⚠️ **Fewer than 100 nodes scores as an ordinary web application, with no node points** (i.e. follow the item 5 and 6 standard).'),

  /* 12 物联网设备管控平台 */
  sp(12, 11, 'Platform 200 / connection point 10 / core network +5000 points', 'iot-platform', 'IoT device control platform privileges', 'NETINFRA', 200, 2000, 'system',
    '**IoT platforms with control capability 200 points; 10 points each counted by connection points on the platform** (G4); this item is capped at 2000 points (G3).\\n'
    + '**Pivoting through an IoT endpoint device into the core network and controlling important systems such as business production adds 5000 points separately** (not bound by this item\'s 2000-point cap; record it as a separate hit).'),

  /* 13 安全设备 */
  sp(13, 12, 'Admin 200 points', 'secdev', 'Security device privileges (IPS, IDS, audit devices, WAF, and other non-centralized security devices)', 'NETINFRA', 200, 1000, 'service',
    '**Admin privileges 200 points**; this item is capped at 1000 points (G3). Restricted to non-centralized security devices (centralized ones go to item 7).'),

  /* 14 文件存储类系统 */
  sp(14, 13, 'Admin 50 / ordinary 10 points each', 'file-storage', 'File storage system privileges (FTP, object storage, enterprise NAS, enterprise cloud drives, etc.)', 'STORAGE', 50, 500, 'system',
    '**Admin privileges 50 points each; ordinary user privileges, empty systems, or systems holding only test data 10 points each**; this item is capped at 500 points (G3).\\n'
    + 'Covers FTP, object storage (scored per system), enterprise NAS, enterprise cloud drives, etc.; data scores separately (G2). When only ordinary privileges are obtained, adjust the per-hit points to 10.'),

  /* 15 模型智能体 / agent 工具 */
  sp(15, 14, '100–500 points each', 'ai-agent', 'Model agents, skills, and other agent tools (and the ability to operate the agent to attack)', 'MODEL', 100, 4000, 'service',
    '**100–500 points each**, a range scored by assessed depth of control and manipulation; this item is capped at 4000 points (G3).\\n'
    + 'Covers model agents, skills, and other agent tools; when scoring, state the depth of control/manipulation in evidence and adjust the per-hit points to the assessed tier.'),

  /* 16、17 算力管理平台 + 训练数据/知识库系统（原表两项规则逐字相同） */
  sp(16, 15, 'System administrator privileges 500 points each', 'model-compute', 'Compute management platform privileges / training-data and knowledge-base system privileges', 'MODEL', 500, 4000, 'system',
    '**Acquiring system administrator privileges 500 points each**; this item is capped at 4000 points (G3).\\n'
    + 'This item merges items 16 and 17 of the original table (rules identical word for word); when scoring, state in evidence which kind of system it is:\\n'
    + '· **Compute management platform** (able to manage and schedule compute resources, etc.);\\n'
    + '· **Training data, knowledge base, and related systems** (ability to steal or tamper with training data or knowledge bases, carry out data poisoning, etc.).\\n'
    + 'Large-data systems (over 100 million records or 10TB) **double the score**, and controlling knowledge-base-related systems **doubles the score** (G5).'),

  /* 18 模型相关数据系统 */
  sp(18, 16, 'System administrator privileges 500 points each', 'model-data', 'Model-related data system privileges', 'MODEL', 500, 4000, 'system',
    '**Acquiring system administrator privileges 500 points each**; this item is capped at 4000 points (G3).\\n'
    + 'Able to disrupt model training, inference, and operational services, and to steal or tamper with model weight files.\\n'
    + '⚠️ The difference from items 16 and 17 **must not be smoothed over**: this item **has no "doubled score for controlling knowledge-base-related systems"**, but does have "data-asset findings scored by the data rules" (G2);'
    + 'Very large data-scale systems (over 100 million records or over 10TB) double the score (G5).'),

  /* 19 算力基础设施（权限与算力卡两种计费单位，保留两条） */
  sp(19, 17, 'Admin 500 points each', 'computepower-admin', 'Compute infrastructure · admin privileges', 'MODEL', 500, 2000, 'system',
    '**Admin privileges 500 points each**; this item is capped at 2000 points (including path points, G3).\\n'
    + 'This item belongs to item 19 together with "compute infrastructure · compute-card resources" and shares the 2000-point cap; the three (admin privileges / large compute-card resources / compute-card pooling platform) can each score separately but are bound by this overall cap.'),
  sp(19, 18, '10 points per card', 'computepower-cards', 'Compute infrastructure · compute-card resources / compute-card pooling platform', 'MODEL', 10, 2000, 'none',
    '**10 points per card**, accumulated per card (G4); scoring for acquiring large compute-card resources and for acquiring a compute-card pooling platform score directly, each capped at 2000 points, and share the 2000-point overall cap of item 19 together with "admin privileges".\\n'
    + 'When scoring, state the number of cards or the platform name in evidence.'),

  /* ══ 二、突破网络边界（4 项，整个目标单位同一类边界只给一次分）══════════ */

  sp(22, 19, '1000 points', 'boundary-logical', 'Entering the logically isolated business intranet', 'BOUNDARY', 1000, 0, 'target',
    '**1000 points**. Scope: a single target organization scores only once per class of network boundary breached.\\n'
    + 'Proof materials (G7): screenshots of control over firewall isolation devices, proof of intranet access, etc.'),
  sp(23, 20, '10000 points', 'boundary-strong', 'Entering the logically strongly isolated business intranet', 'BOUNDARY', 10000, 0, 'target',
    '**10000 points**. Scope: a single target organization scores only once per class of network boundary breached.\\n'
    + 'Proof materials (G7): screenshots of control over gateway-type isolation devices, proof of intranet access, etc.'),
  sp(24, 21, '30000 points', 'boundary-physical', 'Entering the physically isolated intranet, core production network', 'BOUNDARY', 30000, 0, 'target',
    '**30000 points**. Scope: a single target organization scores only once per class of network boundary breached.\\n'
    + 'Proof materials (G7): screenshots of control over firewalls, VPNs, multi-NIC hosts, network devices, and gateway-type isolation devices, plus proof of intranet access, etc.\\n'
    + 'Such as railway dispatch private networks, bank core accounting networks, power production control zones, carrier signaling networks, energy production IoT, etc.'),
  sp(25, 22, '1000 points (up to 3000)', 'boundary-supply', 'Entering the intranet via a supply-chain operations channel or cloud service', 'BOUNDARY', 1000, 3000, 'service',
    'Scored under three scenarios:\\n'
    + '· Entering **the intranet of the same primary-defense organization**: 1000 points;\\n'
    + '· Entering the intranets of **multiple** primary-defense organizations via **one** supply-chain organization or cloud service: 1000 points per primary-defense organization;\\n'
    + '· Entering different network zones of **one** primary-defense organization\'s intranet via **multiple** supply-chain organizations or cloud services: 1000 points each, up to 3000 points.\\n'
    + 'When scoring, state in evidence which scenario applies and which primary-defense organization / network zone is involved.'),

  /* ══ 附加成果加成（依附于上面某条权限，但**独立计分、独立上限**）══════════
     这些条目不是「再拿一个系统权限」，而是「在已拿到的权限上又做到了某件事」（文档里的 +N 分）。
     压在基础条目里会共用它的 rule 上限、被基础分吃掉，所以拆成独立得分点。 */

  /* 9 网络设备加成：能够借助该设备进行网络重定向或业务劫持 +200 分 */
  sp(9, 23, 'Redirection / business hijacking +200 points', 'netdev-redirect', 'Network devices · using the device for network redirection or business hijacking', 'NETINFRA', 200, 2000, 'none',
    '**Adds 200 points on top of the original "network device privileges" points** (item 9 of the document).\\n'
    + 'Applies to: redirections that actually take effect, such as changing routes/policies to steer traffic to our controlled nodes, DNS hijacking, business-traffic hijacking.\\n'
    + 'Evidence is required (G7): routing tables, policy configuration, or connection-volume screenshots; state the redirection direction and how it was verified in evidence.'),

  /* 9 网络设备加成：能在设备上植入远控程序并成功进行后续攻击 1000 分 */
  sp(9, 24, 'Remote-control implant + follow-on attacks 1000 points', 'netdev-implant', 'Network devices · implanting a remote-control program and successfully conducting follow-on attacks', 'NETINFRA', 1000, 2000, 'none',
    '**Adds 1000 points on top of the original "network device privileges" points** (item 9 of the document).\\n'
    + 'Two things must be proven: "implantation succeeded **and** follow-on attacks were carried out through it": remote-control process/persistence evidence + follow-on findings launched from that device.'),

  /* 12 物联网：通过端点设备打入核心网并控制业务生产等重要系统，单独加 5000 分 */
  sp(12, 25, 'Core network +5000 points', 'iot-corenet', 'IoT · pivoting through endpoint devices into the core network and controlling important systems', 'NETINFRA', 5000, 5000, 'none',
    '**Item 12 of the document explicitly states "add 5000 points separately"**, which does not count against that item\'s 2000-point cap.\\n'
    + 'Applies to: lateral movement from IoT endpoint devices into the core network, with control of important systems such as business production;\\n'
    + 'State clearly in evidence: which endpoint was used to enter, which systems in the core network were controlled, and what privileges were obtained.'),
]

/* ------------------------------------------------------------------ 内部辅助的导出 */

/**
 * 下面这些原本是 core.js 里的模块级函数（不对外导出），拆出来之后 core.js 需要用到，
 * 所以显式导出。它们不属于"An API meant for others"，改签名前先看 core.js 的用法。
 */
export {
  normalizePort, targetAuthority, systemKeyOf, pickBestHit, legacyCapGroup,
  targetHasIpv6Host, evaluateScoreBoard, loadScoreMeta, loadAssetNames, hitPointsOf,
  scoreMultiplierOf,
}
