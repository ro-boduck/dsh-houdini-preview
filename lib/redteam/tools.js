/**
 * RedTeam 智能体工具集（preset 平面）
 *
 * 这些行只向 `tools` 注册模型可见工具，自身不发布任何服务，因此不需要 isolate realm；
 * 它们解析的是 host 平面的 `ctx.redteam`（dsh-redteam-store 发布的进程级实例）。
 *
 * 设计约定：
 *   · 写入一律走 redteam_asset_add / redteam_asset_link，智能体不直接碰 SQL；
 *   · 每次发现都带 provenance（passive|active）与 tool，保证界面上的来源标注可信；
 *   · **靶标按根会话隔离**：绑定键是会话的根祖先 id，子智能体顺着
 *     `session.header.parentSession` 继承父会话的靶标 —— 多会话并行时互不串写，
 *     报告不会再被别的靶标的成果污染（v0.9.0 之前的全局「当前靶标」指针正是串写的根源）；
 *   · 并发硬约束：`redteam_agent_slot` 用 `ctx.subagents.listChildren` 的真实运行数
 *     卡住"At most 3 execution agents per target"，超了直接拒绝，不靠提示词自觉。
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ROLE_TITLES, PLANNER_ROLE, ROLE_ORDER } from './store-core.js'
/* 技能可用性判定只有一份实现：面板的「技能库」页签与这里共用（见该文件头注释） */
import { bundledSkillSummaries, checkSkill, summarizeSkills, expandSkillPath, redteamSummariesForCheck } from './skill-availability.js'
import {
  loadPlatformConfig,
  mergeConfigEnv,
  platformSummary,
  toolkitDirOf,
} from './platform-config.js'
import { maxAgentsOf } from './settings.js'
import { EvidenceLedger, UnknownRegistry } from './evidence-ledger.mjs'

/**
 * link: 源码包不在 profile node_modules 树内，静态 import `@deepseek-ai/dsh-tools`
 * 会解析失败 → 预设行 fiber 为 undefined（never started）→ 整份「红队模式」被下拉过滤。
 * 这里从运行中的 dsh / profile 路径 createRequire。
 */
function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。 */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

function loadDefineTool() {
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* 插件自己的 node_modules 里没有，再扫宿主 */ }
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  try { considerBin(candidates, process.execPath) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const resources = process.resourcesPath || ''
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  const desktopRoots = [
    resources,
    exeDir ? join(exeDir, 'resources') : '',
    exeDir,
  ].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('dsh-purge/redteam/tools: cannot resolve @deepseek-ai/dsh-tools from host')
}

const defineToolRaw = loadDefineTool()

/** 0.2.1：任何 type=object 都必须显式 additionalProperties，否则整份红队预设加载失败。 */
function sealObjectSchemas(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const item of node) sealObjectSchemas(item)
    return node
  }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    node.additionalProperties = node.properties ? false : true
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) sealObjectSchemas(node.properties[key])
  }
  if (node.items) sealObjectSchemas(node.items)
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    sealObjectSchemas(node.additionalProperties)
  }
  return node
}

function defineTool(spec) {
  if (spec && spec.parameters) sealObjectSchemas(spec.parameters)
  const tool = defineToolRaw(spec)
  if (tool && tool.parameters) sealObjectSchemas(tool.parameters)
  if (tool && tool.inputSchema) sealObjectSchemas(tool.inputSchema)
  if (tool && tool.schema) sealObjectSchemas(tool.schema)
  return tool
}

/** Cordis 插件名。 */
export const name = 'dsh-purge-redteam-tools'

/** 硬依赖工具注册表；`redteam` 在 host 平面由 store 发布，预设域内用软取。 */
export const inject = ['tools']

/** 根会话 id → engagementId 绑定（一次会话内稳定；进程重启后由 agent 重新绑定）。 */
const bindings = new Map()

/** 并发闸门：根会话 id → Map(子智能体键 → 预留时间戳)。子智能体结束时自动释放。 */
const reservations = new Map()

/** FIFO cap:长会话累积失效的 session id,防无限涨。订单最老的被淘汰(FIFO,近似 LRU)。 */
const BINDINGS_CAP = 500
const RESERVATIONS_CAP = 500
function capMap(m, cap) {
  const origSet = m.set.bind(m)
  m.set = (k, v) => {
    if (!m.has(k) && m.size >= cap) {
      const first = m.keys().next().value
      if (first !== undefined) m.delete(first)
    }
    return origSet(k, v)
  }
}
capMap(bindings, BINDINGS_CAP)
capMap(reservations, RESERVATIONS_CAP)

/** 并发上限：每次调用现读 settings.json → REDTEAM_MAX_AGENTS → 默认 3。 */
function maxAgentsNow(ctx) {
  const root = (() => { try { return ctx.redteam.root } catch { return undefined } })()
  return maxAgentsOf(root, process.env)
}

/** 一次调用的会话解析结果。 */
function sessionInfoOf(exec) {
  const agent = exec && exec.agent
  const session = agent && agent.session
  if (session === undefined || session === null) return {}
  const id = session.id === undefined ? undefined : String(session.id)
  let parentId
  try {
    const header = session.header
    parentId = header && header.parentSession !== undefined && header.parentSession !== null
      ? String(header.parentSession)
      : undefined
  } catch { parentId = undefined }
  return { id: id, parentId: parentId, session: session }
}

/**
 * 解析"Root session"：一路沿 parentSession 走到最顶层的会话 id。
 * 主会话派出的子智能体因此共享同一个绑定键，而**不同主会话之间天然隔离**。
 * 顺手把沿途会话 id 都返回，便于把绑定缓存到子会话上。
 */
function resolveRootSession(session) {
  const chain = []
  let cur = session
  let guard = 0
  while (cur !== undefined && cur !== null && guard < 64) {
    const info = sessionInfoOf({ agent: { session: cur } })
    if (info.id === undefined) break
    chain.push(info.id)
    if (info.parentId === undefined || info.parentId === '') break
    let parent
    try {
      const store = cur.store
      parent = store && typeof store.get === 'function' ? store.get(info.parentId) : undefined
    } catch { parent = undefined }
    if (parent === undefined || parent === null) {
      /* 父会话不在内存里（被回收 / 冷启动）：父 id 本身就是稳定的根键 */
      return { rootId: info.parentId, chain: chain.concat([info.parentId]) }
    }
    cur = parent
    guard += 1
  }
  return { rootId: chain.length > 0 ? chain[chain.length - 1] : undefined, chain: chain }
}

/** 绑定键 + 会话链。 */
function bindingKeyOf(exec) {
  const info = sessionInfoOf(exec)
  if (info.id === undefined) return { rootId: undefined, sessionId: undefined, chain: [] }
  const resolved = resolveRootSession(info.session)
  const rootId = resolved.rootId === undefined ? info.id : resolved.rootId
  return { rootId, sessionId: info.id, chain: resolved.chain }
}

/**
 * 解析本次调用应作用在哪个靶标上（会话隔离版）。
 *
 * 顺序：① 显式传入 → ② 本会话/父链上的绑定 → ③ 全局「当前靶标」指针
 * （仅当没有被别的会话占用；被占用时报错并提示显式绑定，**绝不静默串写**）。
 *
 * 抛错而不是"Pick one at random"是刻意的：多会话并行时挑错靶标 = 把 A 单位的成果写进
 * B 单位的库、A 的报告里出现 B 的数据（这正是要多会话隔离的原因）。
 */
function resolveEngagement(store, exec, explicit) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  const keys = Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
  for (const key of keys) {
    const bound = bindings.get(key)
    if (typeof bound === 'string' && bound.length > 0) return bound
  }
  if (typeof store.activeEngagementId === 'function') {
    const active = store.activeEngagementId()
    if (active !== undefined) {
      const holder = Array.from(bindings.entries()).find(([k, v]) => v === active && !keys.includes(k))
      if (holder !== undefined) {
        throw new Error(
          'This session has no target bound yet, while the global "current target"' + active + ' is already occupied by another session;'
          + 'To avoid several sessions cross-writing the same target library, bind explicitly: redteam_engagement_open (create/open)'
          + ' or redteam_session_bind (bind to an existing target).',
        )
      }
      for (const key of keys) bindings.set(key, active)
      return active
    }
  }
  const list = store.listEngagements()
  if (list.length === 1) {
    for (const key of keys) bindings.set(key, list[0].id)
    return list[0].id
  }
  throw new Error('No target bound yet: call redteam_engagement_open first and pass the target organization name')
}

/** 当前会话的绑定关系（redteam_session_info 与面板展示用）。 */
function bindingViewOf(exec) {
  const info = sessionInfoOf(exec)
  const { rootId, chain } = bindingKeyOf(exec)
  return {
    session_id: info.id ?? null,
    parent_session: info.parentId ?? null,
    root_session: rootId ?? null,
    session_chain: chain,
    is_subagent: info.parentId !== undefined,
    bound_engagement: rootId !== undefined ? (bindings.get(rootId) ?? null) : null,
  }
}

/** 逗号/空白分隔的清单 → 去重数组。 */
function splitList(value) {
  return String(value || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
}

/** 把一行资产压成模型可读的紧凑结构（避免把整库原始数据塞进上下文）。 */
function compactAsset(a) {
  return {
    id: a.id,
    ip: a.ip,
    segment: a.segment_cidr,
    state: a.state,
    name: a.primary_name,
    names: a.names.map((n) => n.name),
    ports: a.ports.filter((p) => p.state === 'open')
      .map((p) => p.port + '/' + p.proto + (p.service ? ' ' + [p.service, p.product, p.version].filter(Boolean).join(' ') : '') + ' [' + p.provenance + ']'),
    fingerprints: a.fingerprints.map((f) => [f.category, f.vendor, f.product, f.version].filter(Boolean).join(' ') + ' [' + f.provenance + ']'),
    passive: a.passive,
    active: a.active,
    /* 发现时间：这条资产第一次进入本库的时刻（面板与报告都按它排时间线） */
    discovered_at: a.discovered_at,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    test_status: a.test_status,
    priority: a.priority,
  }
}

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/** 角色 code 的合法值说明（写进工具 description，模型不用猜）。 */
const ROLE_HINT = 'Role code:' + ROLE_ORDER.map((r) => '`' + r + '`（' + ROLE_TITLES[r] + '）').join('、')

function bindKeysOf(exec) {
  const { rootId, sessionId, chain } = bindingKeyOf(exec)
  return Array.from(new Set([rootId, sessionId, ...chain].filter(Boolean)))
}

/** 实时并发占用：读 subagents 注册表里"Actually running"的直接子会话数。 */
async function liveRunningChildren(ctx, rootSessionId) {
  const subagents = ctx.get('subagents')
  if (subagents === undefined || subagents === null || typeof subagents.listChildren !== 'function') {
    return { available: false, running: 0, error: 'The subagents registry is unavailable (actual concurrency cannot be checked; counting relies on reservations only)' }
  }
  try {
    const entries = await subagents.listChildren(rootSessionId)
    const rows = Array.isArray(entries) ? entries : []
    const running = rows.filter((e) => e && e.kind === 'child' && e.activity === 'running')
    return {
      available: true,
      running: running.length,
      running_labels: running.map((e) => e.label || e.id).slice(0, 20),
      total_children: rows.filter((e) => e && e.kind === 'child').length,
    }
  } catch (error) {
    return { available: false, running: 0, error: 'Failed to list child sessions:' + (error && error.message ? error.message : String(error)) }
  }
}

/** 预留（未被 subagents 注册表覆盖的那部分，例如刚 acquire 还没起来的）。 */
function reservationList(rootId) {
  const map = reservations.get(rootId)
  if (map === undefined) return []
  return Array.from(map, ([key, at]) => ({ key, at }))
}

function addReservation(rootId, key) {
  if (!reservations.has(rootId)) reservations.set(rootId, new Map())
  reservations.get(rootId).set(key, Date.now())
}

function dropReservation(rootId, key) {
  const map = reservations.get(rootId)
  if (map === undefined) return false
  if (key === undefined) {
    /* 无 key 时只释放最早的一条（与工具描述一致）——清空整张表会把别的在途预留一起放掉，名额超卖 */
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, at] of map) {
      if (at < oldestAt) { oldestAt = at; oldestKey = k }
    }
    return oldestKey !== null ? map.delete(oldestKey) : false
  }
  return map.delete(key)
}

/**
 * 产出这条记录的智能体角色：显式传的优先，否则默认按主会话记账。
 * 这个值会写进库里的 `agent` 列，报告里"Who did this step"就靠它。
 */
function agentOf(args) {
  const raw = typeof args.agent === 'string' ? args.agent.trim() : ''
  return raw !== '' ? raw : PLANNER_ROLE
}

/** 写库工具共用的 agent 参数（角色 code 白名单提示写进 description）。 */
const AGENT_PARAM = {
  type: 'string',
  description: '[Recommended] The role that produced this record — ' + ROLE_HINT
    + '. The report uses it to mark "who did this step"; when empty it is booked to the main session.',
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 为什么需要：同一类错误（对象不存在 / 参数非法）此前有两种形态 ——
 * 有的工具 `return { ok:false, error }`，有的直接抛。模型拿到前者能换参数重试，
 * 拿到后者往往直接放弃这一次调用，行为不可预测。统一成前者，且**不吞原始信息**。
 * @param tool - defineTool 的返回值。
 * @returns 包了一层 try/catch 的同一个工具定义。
 */
function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        /* 参数类错误（非法值/缺必填）与"Object not found"分开提示，模型据此决定重试还是放弃 */
        const kind = /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          hint: kind === 'bad_input'
            ? 'This is a parameter or object identifier problem: check the parameter names and values (you can use the matching *_list / *_query tool to see the actual id first), then retry after fixing.'
            : 'Tool execution failed; the original error is in the error field; do not silently skip it — first explain the blocker to the user or the commander.',
        }, null, 2)
      }
    },
  })
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (!store) {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools: host ctx.redteam unavailable — tools will report store_missing')
    store = {
      openEngagement: () => { throw new Error('The red team asset library is unavailable') },
      listEngagements: () => [],
      stats: () => ({}),
    }
  }

  /* ── 子智能体结束时自动释放并发名额（不依赖模型记得调 release）──────────── */
  /* ctx.effect 包起来 → plugin dispose 时解绑 subagent/end,否则 handler 残留 + 热重载翻倍。 */
  ctx.effect(() => {
    let disposer = null
    try {
      disposer = ctx.on('subagent/end', (info, parent) => {
        const parentSession = parent && parent.session
        const { rootId } = bindingKeyOf({ agent: { session: parentSession } })
        const childId = info && info.id !== undefined ? String(info.id) : undefined
        if (rootId === undefined) return
        if (childId !== undefined && dropReservation(rootId, childId)) return
        /* 注册表里的键可能与 runId 不同：按时间兜底清掉最早的一个预留 */
        const map = reservations.get(rootId)
        if (map === undefined || map.size === 0) return
        let oldestKey
        let oldestAt = Number.POSITIVE_INFINITY
        for (const [key, at] of map) { if (at < oldestAt) { oldestAt = at; oldestKey = key } }
        if (oldestKey !== undefined) map.delete(oldestKey)
      })
    } catch { /* 事件不可用时只影响自动释放，手动 release 仍然可用 */ }
    return () => { try { if (typeof disposer === 'function') disposer() } catch { /* ignore */ } }
  })

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_engagement_open',
    description: 'Open or create an attack-and-defense drill target (by organization name) and bind the **current session** to it (subagents inherit it automatically). All later asset tools act on it by default. If the target already exists its asset library is reused. What is written is this session\'s binding and does not touch the target other sessions are using.',
    parameters: {
      target: { type: 'string', required: true, description: 'Target organization name, e.g. "Example Technology Co., Ltd."' },
      scope: {
        type: 'array',
        description: 'Authorized scope CIDR list (optional: if the user did not provide one, do not ask; proceed autonomously over the publicly visible asset surface)',
        items: { type: 'string' },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      /* bindCurrent: false —— 不动全局「当前靶标」指针：多会话并行时那个指针是串写的根源 */
      const engagement = store.openEngagement(args.target, args.scope, { bindCurrent: false })
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, engagement.id)
      const view = bindingViewOf(exec)
      return JSON.stringify({
        ok: true,
        engagement,
        stats: store.stats(engagement.id),
        session: view,
        note: 'Bound to this session (session isolation: other sessions\' bindings are unaffected); subagents inherit this target.'
          + (view.is_subagent ? ' Note: this session is a subagent, so there is normally no need to open again — just inherit the parent session\'s target.' : ''),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_bind',
    description: 'Bind an **already existing** target to the current session (for parallel sessions: each session binds its own target so they never cross-write). You can use a target id or an organization name; when omitted it lists bindable targets.',
    parameters: {
      engagement: { type: 'string', description: 'Target id or organization name; when omitted only candidates are listed' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const list = store.listEngagements({ stats: true })
      const wanted = typeof args.engagement === 'string' ? args.engagement.trim() : ''
      if (wanted === '') {
        return JSON.stringify({
          ok: false,
          candidates: list.map((e) => ({ id: e.id, name: e.name, created_at: e.created_at, stats: e.stats })),
          note: 'Please pass engagement (target id or organization name) to complete the binding.',
        }, null, 2)
      }
      const hit = list.find((e) => e.id === wanted)
        || list.find((e) => String(e.name) === wanted)
        || list.find((e) => String(e.name).includes(wanted))
      if (hit === undefined) {
        return JSON.stringify({ ok: false, error: 'Target does not exist:' + wanted, candidates: list.map((e) => e.id) }, null, 2)
      }
      const keys = bindKeysOf(exec)
      for (const key of keys) bindings.set(key, hit.id)
      return JSON.stringify({
        ok: true, engagement: { id: hit.id, name: hit.name },
        session: bindingViewOf(exec),
        note: 'This session is bound to "' + hit.name + '"; all later tools and reports act on it only.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_info',
    description: 'Show **which target the current session is bound to** (session id, parent session, root session, binding chain). When several sessions start at once, run it first to make sure you are not writing into someone else\'s target.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(_args, exec) {
      const view = bindingViewOf(exec)
      const changed = view.bound_engagement !== null ? store.stats(view.bound_engagement) : null
      return JSON.stringify({
        ok: true, session: view, stats: changed,
        bindings_now: Array.from(bindings, ([k, v]) => ({ session: k, engagement: v })),
        note: 'The binding is in-process state: after dsh restarts, each session must bind again (redteam_engagement_open / redteam_session_bind).',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_preflight',
    description: '[Must run once before starting work] Platform skill and resource self-check: inspect each red team skill\'s required environment variables (e.g. FOFA_KEY for FOFA mapping), local tools and binaries (suo5 / fscan / gogo / frp / Behinder / Godzilla / nmap / nuclei…), and external infrastructure (the VPS used for reverse shells). Return the available/broken list and, for each broken skill, "what is missing, how to fix it". **When a key / VPS is missing, ask the user directly or switch to an alternative plan — do not pretend it can run.**',
    parameters: {
      include: { type: 'string', description: 'Only check these skills (comma separated); when omitted all red team skills are checked' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args) {
      let skills
      try { skills = typeof ctx.get === 'function' ? ctx.get('skills') : null } catch { skills = null }
      const plat = platformSummary()
      const cfg = loadPlatformConfig()
      /* 环境变量的真实来源：进程环境 + $DSH_HOME/.env + 平台 config.json env */
      const envFile = expandSkillPath('$DSH_HOME/.env')
      const effectiveEnv = mergeConfigEnv({ ...process.env }, cfg)
      let envFileKeys = []
      try {
        if (existsSync(envFile)) {
          const { readFileSync } = await import('node:fs')
          for (const line of readFileSync(envFile, 'utf8').split('\n')) {
            /* 兼容 shell 习惯写法：`export KEY=value`；未加引号的行内注释（`KEY=v # note`）剥掉 */
            const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
            if (m === null) continue
            const key = m[1]
            let raw = m[2].trim()
            if (!/^["']/.test(raw)) raw = raw.replace(/\s+#.*$/, '')
            const value = raw.replace(/^["']|["']$/g, '').trim()
            if (value === '') continue
            envFileKeys.push(key)
            if (effectiveEnv[key] === undefined || effectiveEnv[key] === '') effectiveEnv[key] = value
          }
        }
      } catch { /* .env 读不到不影响主流程 */ }

      const toolkit = toolkitDirOf(cfg)
      let toolkitEntries = []
      try {
        if (existsSync(toolkit)) {
          const { readdirSync } = await import('node:fs')
          toolkitEntries = readdirSync(toolkit).slice(0, 60)
        }
      } catch { /* 忽略 */ }

      const redteamDir = expandSkillPath('$DSH_HOME/redteam')
      const markerFile = redteamDir + '/.setup-complete'
      const setupScript = redteamDir + '/setup.sh'
      const hasMarker = existsSync(markerFile)
      const hasSetupScript = existsSync(setupScript)
      const toolkitHint = 'This plugin does not download or install tools on the user\'s behalf. On Windows, or when there is no setup.sh, fill in paths, FOFA_KEY and VPS on the drill console\'s "Environment Adaptation" page; when `$DSH_HOME/redteam/setup.sh` already exists locally, the user runs `--check` themselves — the agent must not run `--yes` to download binaries.'
      let fofaKey = effectiveEnv.FOFA_KEY || ''
      const vpsKey = effectiveEnv.REDTEAM_VPS_KEY || (toolkit + (plat.runtime.windows ? '\\vps\\id_rsa' : '/vps/id_rsa'))
      const vpsHost = effectiveEnv.REDTEAM_VPS_HOST || ''
      const hasVps = existsSync(vpsKey)
      const missing = []
      if (fofaKey === '') missing.push('FOFA_KEY (asset mapping: fill it on the "Environment Adaptation" page, or write it into $DSH_HOME/.env)')
      if (!hasVps) {
        missing.push(plat.runtime.windows
          ? 'VPS private key (fill the REDTEAM_VPS_KEY path and REDTEAM_VPS_HOST on "Environment Adaptation"; Windows does not depend on setup.sh)'
          : 'VPS login method — put the private key in ' + vpsKey + ', and set REDTEAM_VPS_HOST (see the redteam-setup skill, or "Environment Adaptation" on the drill console)')
      }
      const fofaShown = fofaKey.length > 8 ? fofaKey.slice(0, 4) + '…' + fofaKey.slice(-4) : '(configured)'
      const runtimeHint = plat.runtime.windows
        ? 'Currently a **Windows adaptation**: configure tool paths/search directories and FOFA/VPS on the drill console\'s "Environment Adaptation" page; do not assume Kali/`bash setup.sh` exists. A dedicated drill machine is still recommended — do not drop private keys and scanners on a daily office machine.'
        : 'This mode is best run inside a **Kali VM dedicated to drills**; do not run it on a daily office machine/host'
          + '(the machine holds the VPS private key and WebShell shells, and scan traffic also leaves from the usual egress IP; the VM can simply be discarded after the drill).'

      let checked = []
      let allBroken = []
      let allAvailable = []
      let broken = []
      let available = []
      let only = splitList(args.include)
      let unknownIncludes = []

      const bundledSkills = bundledSkillSummaries()
      const skillsMissing = skills === undefined || skills === null || typeof skills.list !== 'function'
      if (skillsMissing && bundledSkills.length === 0) {
        /* 桌面端常无 skills inject：仍返回平台工具探测，避免整条 preflight 报废 */
        const toolMissing = (plat.tools.items || []).filter((t) => !t.path).map((t) => t.id)
        if (toolMissing.length) {
          missing.push('Unresolved tools (fill paths on "Environment Adaptation" or add search directories):' + toolMissing.slice(0, 12).join(', '))
        }
        const onboarding = {
          complete: hasMarker && missing.length === 0,
          runtime_hint: runtimeHint,
          first_run: !hasMarker,
          marker: { path: markerFile, exists: hasMarker },
          setup_script: { path: setupScript, exists: hasSetupScript },
          toolkit_hint: toolkitHint,
          configured: {
            fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
            vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
            vps_host: vpsHost,
            env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
            platform_config: { path: cfg.path, exists: !!cfg.exists },
          },
          missing,
        }
        return JSON.stringify({
          ok: missing.length === 0 && toolMissing.length === 0,
          onboarding,
          platform: plat,
          toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
          skills_root_hint: 'The host skills service is unavailable: skill body checks were skipped, only platform tool probing is returned. Please configure paths on "Environment Adaptation".',
          next: plat.runtime.windows
            ? 'Open the drill console\'s "Environment Adaptation": ① fill binDirs (your tool folders) or each tools path ② fill FOFA_KEY / VPS ③ save and run preflight again. Do not download tools for the user.'
            : (hasSetupScript
              ? 'The user can run bash "$DSH_HOME/redteam/setup.sh" --check themselves, or fill the paths by hand on "Environment Adaptation". The agent must not download tools.'
              : 'There is no setup.sh on this machine, which is normal. Fill the paths by hand on the drill console\'s "Environment Adaptation", or configure item by item following the redteam-setup skill.'),
        }, null, 2)
      }

      let summaries = []
      let fromBundle = skillsMissing
      let scoped = false
      if (fromBundle) {
        summaries = bundledSkills
      } else {
        try {
          let scope = null
          try {
            const presets = typeof ctx.get === 'function' ? ctx.get('agentPresets') : null
            if (presets && typeof presets.standingKeyFor === 'function') {
              scope = await presets.standingKeyFor('redteam')
            }
          } catch { scope = null }
          scoped = scope != null
          const listed = scoped ? await skills.list({ scope }) : await skills.list()
          summaries = redteamSummariesForCheck(listed, bundledSkills, scoped)
          fromBundle = summaries.every((item) => item && item.library === 'redteam' && item.content)
        } catch (error) {
          if (bundledSkills.length === 0) {
            return JSON.stringify({ ok: false, error: 'Failed to read the skills directory:' + (error && error.message ? error.message : String(error)), platform: plat }, null, 2)
          }
          summaries = bundledSkills
          fromBundle = true
        }
      }
      summaries = redteamSummariesForCheck(summaries, bundledSkills, scoped)
      const wanted = summaries.filter((s) => only.length === 0 || only.includes(s.name))
      /* include 时只体检点名的技能：否则 ok 被无关 broken 拖成 false，模型会误以为目标技能坏了 */
      const toCheck = only.length > 0 ? wanted : summaries
      unknownIncludes = only.filter((n) => !summaries.some((s) => s.name === n))
      const rootsWith = new Map()
      for (const x of summaries) {
        const dir = x.resourceBase && x.resourceBase.kind === 'directory' ? x.resourceBase.path : null
        if (dir === null) continue
        if (!rootsWith.has(x.name)) rootsWith.set(x.name, [])
        if (!rootsWith.get(x.name).includes(dir)) rootsWith.get(x.name).push(dir)
      }
      for (const summary of toCheck) {
        let def
        if (!fromBundle && skills && typeof skills.get === 'function') {
          try { def = await skills.get(summary.name) } catch { def = undefined }
        }
        const path = def && typeof def.path === 'string'
          ? def.path
          : (typeof summary.path === 'string'
            ? summary.path
            : (summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null))
        const root = summary.resourceBase && summary.resourceBase.kind === 'directory' ? summary.resourceBase.path : null
        const content = def && typeof def.content === 'string' && def.content.trim() !== ''
          ? def.content
          : summary.content
        const verdict = checkSkill({ name: summary.name, content, path, root },
          { env: effectiveEnv, sameNameIn: rootsWith.get(summary.name) || [] })
        checked.push(Object.assign({}, verdict, {
          title: summary.description,
          path,
          when_to_use: summary.whenToUse || '',
          needs_user: verdict.needs_user.map((n) => (n.startsWith('Environment variable')
            ? n + (plat.runtime.windows ? '(can be filled on the "Environment Adaptation" page)' : '(after obtaining it, export and restart dsh web)')
            : n === 'VPS address' || n === 'VPS hostname'
              ? 'For reverse shell / payload delivery ' + n + '(still a placeholder in the skill)'
              : n)),
        }))
      }
      allBroken = checked.filter((s) => s.status === 'broken')
      allAvailable = checked.filter((s) => s.status === 'available')
      const shown = (x) => only.length === 0 || only.includes(x.name)
      broken = allBroken.filter(shown)
      available = allAvailable.filter(shown)
      const toolMissing = (plat.tools.items || []).filter((t) => !t.path)
      if (toolMissing.length) {
        missing.push('Unresolved local tools (fill paths on "Environment Adaptation"):' + toolMissing.slice(0, 10).map((t) => t.id).join(', '))
      }
      const needsUser = Array.from(new Set(broken.flatMap((s) => s.needs_user)))
      const onboarding = {
        complete: hasMarker && missing.length === 0 && allBroken.length === 0,
        runtime_hint: runtimeHint,
        first_run: !hasMarker,
        marker: { path: markerFile, exists: hasMarker },
        setup_script: { path: setupScript, exists: hasSetupScript },
        toolkit_hint: toolkitHint,
        configured: {
          fofa_key: fofaKey === '' ? 'missing' : 'configured(' + fofaShown + ')',
          vps_key: hasVps ? 'configured(' + vpsKey + ')' : 'missing',
          vps_host: vpsHost,
          env_file: { path: envFile, exists: existsSync(envFile), keys: envFileKeys },
          platform_config: { path: cfg.path, exists: !!cfg.exists },
        },
        missing,
      }
      let next
      if (plat.runtime.windows && (!hasMarker || missing.length > 0 || allBroken.length > 0)) {
        next = 'Windows: open the drill console\'s "Environment Adaptation" and configure the toolkit/binDirs/tools paths and FOFA/VPS, save, then rerun redteam_preflight; when a skill body lacks a path, prefer the already-resolved absolute tool path.'
      } else if (!hasMarker && !hasSetupScript) {
        next = 'First use, and no install script on this machine ' + setupScript + '(this is normal, not a failure).'
          + toolkitHint + ' List onboarding.missing to the user in one go; if it cannot be completed, state the degraded plan: without FOFA use crt.sh / passive DNS, without a VPS produce only results that need no landing.'
      } else if (!hasMarker) {
        next = '**First use**: have the user run it themselves `bash ' + setupScript + ' --check`, or open the drill console\'s "Environment Adaptation". The agent must not run --yes to download tools.'
      } else if (missing.length > 0) {
        next = 'Gaps exist: list onboarding.missing to the user in one go. On Windows or without setup.sh go through "Environment Adaptation"; even when the script exists, only let the user run it — do not download tools for the user.'
      } else if (allBroken.length > 0) {
        next = 'List needs_user from broken to the user in one go; if it cannot be completed, state the degraded plan.'
      } else {
        next = 'All available, ready to start.'
      }

      const summary = summarizeSkills(checked)
      return JSON.stringify({
        /* include 模式：ok 只反映点名技能的体检结果；测绘 key/VPS 等 missing 与此无关，降为参考不拖 ok */
        ok: allBroken.length === 0 && (only.length > 0 || missing.length === 0),
        include: only.length > 0 ? { requested: only, unknown: unknownIncludes, note: 'ok covers only the named skills; onboarding.missing is a global reference and does not affect this ok' } : undefined,
        all_checked: { registry_total: summaries.length, checked: checked.length, broken: allBroken.length, available: allAvailable.length },
        onboarding,
        platform: plat,
        summary,
        checked: checked.length,
        available: available.map((s) => s.name),
        broken: broken.map((s) => ({ name: s.name, problems: s.problems, needs_user: s.needs_user,
          fixes: (s.issues || []).map((i) => i && i.fix).filter(Boolean),
          fix_note: 'Fix steps are carried out by the user (or via the "Environment Adaptation" page); do not download/install tools yourself.' })),
        unknown: checked.filter((s) => s.status === 'unknown').map((s) => s.name),
        toolkit: { dir: toolkit, exists: existsSync(toolkit), entries: toolkitEntries, hint: toolkitHint },
        skills_root_hint: 'Only red team skills are checked here. Official skills live in $DSH_HOME/skills and are not judged unavailable by red team tool paths.',
        next,
        needs_user_flat: needsUser,
        wanted_count: wanted.length,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_agent_slot',
    description: '[Use before and after dispatching work from the main session] Concurrency gate for execution agents: **at most 3** running at once per target (configurable via REDTEAM_MAX_AGENTS). action=status shows how many slots remain and who is running; action=acquire takes one slot (it rejects outright when full — **do not retry and force it**); action=release frees one (the server also releases automatically when a subagent finishes).',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'acquire', 'release'], description: 'status to view / acquire to occupy / release to free' },
      label: { type: 'string', description: 'Task label at acquire time, e.g. "recon: primary domain and C block"' },
      key: { type: 'string', description: 'Key to release at release time (when omitted the earliest reservation is released)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const { rootId, sessionId } = bindingKeyOf(exec)
      const owner = rootId ?? sessionId
      if (owner === undefined) {
        return JSON.stringify({ ok: false, error: 'Cannot obtain the session id: concurrency cannot be counted (confirm the tool call carries agent context).' }, null, 2)
      }
      const live = await liveRunningChildren(ctx, owner)
      const reserved = reservationList(owner)
      /* 注册表里 running 的子会话已经包含正在跑的；预留是"Just reserved, not yet in the registry"的那部分，
         两者取较大值，避免重复计数又不会漏计 */
      const used = Math.max(live.running, reserved.length)
      const cap = maxAgentsNow(ctx)
      const free = Math.max(cap - used, 0)
      const base = {
        ok: true, max: cap, used, free,
        running_from_registry: live.running,
        running_labels: live.running_labels ?? [],
        reservations: reserved,
        registry_available: live.available,
        registry_note: live.available ? undefined : live.error,
      }
      if (args.action === 'status') {
        return JSON.stringify(Object.assign(base, {
          hint: free === 0
            ? 'All slots taken: dispatch after the existing agents report (dispatching one at a time and advancing in order is the steadiest rhythm).'
            : 'Still ' + free + ' slots. Dispatch one at a time by default; parallelize only genuinely independent work.',
        }), null, 2)
      }
      if (args.action === 'acquire') {
        if (free <= 0) {
          return JSON.stringify(Object.assign(base, {
            ok: false,
            error: 'Concurrency full (at most ' + cap + ' slots): no new agents can be dispatched now. Wait for the currently running agents to report, or release the ones that have already finished.',
          }), null, 2)
        }
        const key = (typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : 'slot') + '#' + Date.now()
        addReservation(owner, key)
        return JSON.stringify(Object.assign(base, { slot: key, used: used + 1, free: Math.max(cap - used - 1, 0) }, {
          hint: 'Reserved (' + key + '). **After dispatching, remember**: a subagent releases its slot automatically when it finishes; if dispatching fails (e.g. a tool error), manually run redteam_agent_slot action=release key=' + key + ' to release it.',
        }), null, 2)
      }
      const dropped = dropReservation(owner, typeof args.key === 'string' && args.key.trim() !== '' ? args.key.trim() : undefined)
      return JSON.stringify(Object.assign(base, { ok: true, released: dropped, used: Math.max(used - (dropped ? 1 : 0), 0) }), null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_add',
    description: 'Write an asset and its ports/services/fingerprints into the asset library (idempotent upsert). Every finding must declare provenance: passive for passive collection, active for active probing, and fill in tool (data source or tool name).',
    parameters: {
      engagement: { type: 'string', description: 'Target id; when omitted the target bound to the current session is used' },
      ip: { type: 'string', required: true, description: 'Asset IP (IPv4)' },
      state: { type: 'string', description: 'live | dead | unknown, default unknown' },
      primary_name: { type: 'string', description: 'Primary domain/hostname' },
      provenance: { type: 'string', required: true, enum: ['passive', 'active'], description: 'Source of this finding: passive or active' },
      tool: { type: 'string', description: 'Data source or tool name, e.g. crt.sh / nmap / nuclei / curl' },
      discovered_at: { type: 'string', description: '[Optional] Discovery time of this asset (ISO, e.g. 2026-09-17T09:30:00Z). When omitted it is recorded automatically as "the moment it first entered the library"; passing it in is more accurate when the data source reports a historical first-seen time. **Repeated collection does not overwrite it**.' },
      first_seen: { type: 'string', description: '[Optional] First-seen time reported by the data source/tool (recorded separately from discovery time)' },
      names: {
        type: 'array',
        description: 'Domain/certificate name associated with this asset',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            kind: { type: 'string', description: 'domain | hostname | cert_cn, default domain' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
          },
        },
      },
      ports: {
        type: 'array',
        description: 'Open ports and their services/fingerprints',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            port: { type: 'number', required: true },
            proto: { type: 'string', description: 'tcp (default) | udp' },
            service: { type: 'string', description: 'Service name, e.g. http / mysql' },
            product: { type: 'string', description: 'Product name, e.g. nginx' },
            version: { type: 'string', description: 'Version, e.g. 1.24.0' },
            banner: { type: 'string', description: 'Raw banner fragment' },
            url: { type: 'string', description: 'Full URL directly reachable on the web service, e.g. https://oa.example.com:8443/portal' },
            title: { type: 'string', description: 'Web page title (obtained by HTTP probing), e.g. "Seeyon OA (致远 OA) login"' },
            provenance: { type: 'string', enum: ['passive', 'active'] },
            tool: { type: 'string' },
            fingerprints: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  category: { type: 'string', description: 'Web server | middleware | framework | CMS | database | VPN gateway …' },
                  vendor: { type: 'string' },
                  product: { type: 'string' },
                  version: { type: 'string' },
                  evidence: { type: 'string', description: 'Basis for the judgment, e.g. response headers / path / banner' },
                  confidence: { type: 'number', description: '0–1' },
                },
              },
            },
          },
        },
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = {
        ip: args.ip, state: args.state, primary_name: args.primary_name,
        provenance: args.provenance, tool: args.tool,
        names: args.names, ports: args.ports,
        /* 发现时间：不传则由服务端按"The moment it first entered the library"自动记录；
           数据源能给历史时间（FOFA 的 first_seen 等）就传进来，报告时间线更准 */
        discovered_at: args.discovered_at,
        first_seen: args.first_seen,
      }
      const result = store.importBundle(id, { scan: { tool: args.tool, argv: ['redteam_asset_add'] }, assets: [asset] })
      const written = store.listAssets(id, { ip: args.ip, limit: 1 }).items[0]
      return JSON.stringify({
        ok: true, engagement: id, counts: result.counts,
        asset: written ? compactAsset(written) : null,
        discovered_at: written ? written.discovered_at : null,
        hint: 'The discovery time of this asset is recorded as ' + (written && written.discovered_at ? written.discovered_at : '(unknown)')
          + '; repeated collection only refreshes last_seen and never changes the discovery time.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_link',
    description: 'Write a relationship edge into the asset library (shared by the graph and later lateral analysis). relation e.g. resolves / exposes / contains / trusts / shares_cert.',
    parameters: {
      engagement: { type: 'string' },
      src_kind: { type: 'string', required: true, description: 'segment | asset | domain | port …' },
      src_id: { type: 'string', required: true },
      dst_kind: { type: 'string', required: true },
      dst_id: { type: 'string', required: true },
      relation: { type: 'string', required: true },
      confidence: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.importBundle(id, {
        edges: [{
          src_kind: args.src_kind, src_id: args.src_id,
          dst_kind: args.dst_kind, dst_id: args.dst_id,
          relation: args.relation, confidence: args.confidence,
        }],
      })
      return JSON.stringify({ ok: true, edges: result.counts.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_query',
    description: 'Search the asset library. Supports filtering by C block, port, service, fingerprint, provenance, internal/external dimension (scope), sort order (sort), and keyword (full text, covering IP/domain/banner/service/fingerprint). Returns compact results with each asset\'s open ports, fingerprint and internal/external attribution.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'C block, e.g. 203.0.113.0/24' },
      port: { type: 'number', description: 'Open ports' },
      service: { type: 'string', description: 'Service/product name keyword, e.g. nginx' },
      fingerprint: { type: 'string', description: 'Fingerprint keyword, e.g. Tomcat / Spring' },
      provenance: { type: 'string', enum: ['passive', 'active'], description: 'Only passive or only active sources' },
      q: { type: 'string', description: 'Full-text search terms (multiple words separated by spaces are AND)' },
      state: { type: 'string', enum: ['live', 'dead', 'unknown'] },
      scope: { type: 'string', enum: ['internal', 'external'], description: 'Internal/external dimension: internal=internal/private address, external=internet reachable' },
      sort: { type: 'string', enum: ['priority', 'todo', 'ports', 'ip'], description: 'Sort: priority=ease of compromise first (default), todo=pending tests first, ports=most ports first, ip=by IP' },
      limit: { type: 'number', description: 'Maximum number of returned items, default 50, max 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const limit = Math.min(Number(args.limit) || 50, 200)
      const result = store.listAssets(id, {
        cidr: args.cidr, port: args.port, service: args.service,
        fingerprint: args.fingerprint, provenance: args.provenance,
        q: args.q, state: args.state, scope: args.scope, sort: args.sort, limit,
      })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total, returned: result.items.length,
        items: result.items.map(compactAsset),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_get',
    description: 'Fetch full details of a single asset: all ports and services, fingerprints, collection provenance timeline, relationship edges. Used to analyze a target in depth.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'Asset id (from the redteam_asset_query result)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const asset = store.getAsset(id, args.id)
      if (asset === undefined) return JSON.stringify({ ok: false, error: 'Asset does not exist' })
      return JSON.stringify({ ok: true, asset }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_stats',
    description: 'Asset mapping overview: number of C blocks, number of assets (alive), open ports, services, fingerprints, passive/active provenance counts, and the details of each C block.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, stats: store.stats(id), segments: store.listSegments(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_graph',
    description: 'Export the asset graph (C block → asset → open ports, including domain resolution edges) for topology reasoning and lateral movement path planning. When the node count exceeds the cap, narrow the range by C block.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string', description: 'Only the subgraph of a certain C block' },
      maxNodes: { type: 'number', description: 'Node cap, default 300' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 300, 1000)
      const graph = store.graph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Too many graph nodes (' + graph.nodes.length + ' > ' + maxNodes + '), please specify cidr to narrow the range',
          segments: store.listSegments(id).map((s) => ({ cidr: s.cidr, assets: s.assets })),
        }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, nodes: graph.nodes, edges: graph.edges }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt',
    description: 'Fetch the system prompt currently in effect for a given red team role, for viewing only. When dispatching work do not copy the full text into the task; write redteamRole: <code> on the first line of the subagent\'s prompt and the role prompt enters the child session\'s system prompt.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', required: true, /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const found = store.listPrompts(id).find((p) => p.role === args.role)
      if (found === undefined) return JSON.stringify({ ok: false, error: 'Unknown role' })
      return JSON.stringify({
        ok: true, role: found.role, title: found.title,
        updated_at: found.updated_at, prompt: found.content,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_roles',
    description: 'List red team roles and their responsibility titles (information gathering / vulnerability detection / vulnerability exploitation / internal penetration).',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return JSON.stringify({
        ok: true,
        roles: Object.entries(ROLE_TITLES).map(([role, title]) => ({ role, title })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_test',
    description: 'Record the testing state of an asset: what was tested this time (`test`, append-only), what attack surface remains (`surface`, overwrite), the current test status, and whether it was blocked by a WAF. **Call it once before starting to test each asset (status=testing), and once again when done or abandoned** — the asset mapping page shows "untested / testing / tested / blocked / abandoned / no attack surface" accordingly. Put exclusion conclusions, login failure reasons, and retest rationale in `test`.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number', description: 'Asset id (choose one of this and ip; asset_id is preferred)' },
      ip: { type: 'string', description: 'Asset IP' },
      status: { type: 'string', enum: ['untested', 'testing', 'tested', 'blocked', 'abandoned', 'no_surface'], description: 'Test status: untested/testing/tested/blocked/abandoned/no attack surface' },
      test: { type: 'string', description: 'What was tested this time (**appended** to the test record, e.g. "nmap all ports + nuclei cve templates + API IDOR"). Put exclusion conclusions, login failure reasons, and retest rationale here as well.' },
      notes: { type: 'string', description: 'Compatibility alias for test (the form used in older prompts); it behaves exactly like test and is appended to the test record as well.' },
      surface: { type: 'string', description: 'What attack surface remains testable (overwrite, e.g. "SMB 445 untested; web /api IDOR not done")' },
      blocked: { type: 'boolean', description: 'Whether it was blocked by WAF/protection this time (block counter +1 when true)' },
      updated_by: { type: 'string', description: 'Recording role, e.g. recon / vuln-scan' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateAssetTest(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 漏洞检测 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_add',
    description: 'Record a vulnerability finding (vulnerability detection role). With cve it is updated idempotently by (asset_id, cve, target). severity: critical|high|medium|low|info; status: candidate (pending verification)|confirmed (verified)|false-positive|exploited|fixed. Evidence is mandatory (request/response fragments, reproduction command, evidence file path).',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      asset_id: { type: 'number', description: 'Asset id (from redteam_asset_query)' },
      cve: { type: 'string', description: 'CVE / CNVD id (may be omitted when there is none)' },
      title: { type: 'string', required: true, description: 'Vulnerability title' },
      severity: { type: 'string', required: true, enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      target: { type: 'string', description: 'Affected target, e.g. https://host:443/path or ip:port' },
      source: { type: 'string', description: 'Discovery method: nuclei / sqlmap / curl / manual …' },
      confidence: { type: 'number', description: '0–1' },
      evidence: { type: 'string', description: 'Evidence: request/response summary, command, evidence file path' },
      found_by_agent: { type: 'string', description: 'Discovering role, default vuln-scan' },
      gained: { type: 'string', description: '[Important] What privilege/result this vulnerability yielded, written as short score-caliber labels, separated by commas, e.g. "server privileges, internal tunnel", "backend administrator account", "database privileges"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addVuln(id, { ...args, engagement: undefined, agent: agentOf(args), found_by_agent: args.found_by_agent || args.agent || 'vuln-scan' })
      return JSON.stringify({ ok: true, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_query',
    description: 'Search the vulnerability library: filter by severity, status, CVE, asset, C block or keyword. Used to pick targets to exploit or to check false positives.',
    parameters: {
      engagement: { type: 'string' },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      cve: { type: 'string' },
      asset_id: { type: 'number' },
      cidr: { type: 'string' },
      q: { type: 'string', description: 'Title/CVE/target/evidence keyword' },
      limit: { type: 'number', description: 'Default 50, max 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listVulns(id, { ...args, engagement: undefined, evidenceLimit: 20000, limit: Math.min(Number(args.limit) || 50, 200) })
      return JSON.stringify({ ok: true, engagement: id, total: result.total, items: result.items, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_vuln_update',
    description: 'Update vulnerability status/severity/evidence (e.g. set to confirmed after verification, exploited after successful exploitation, false-positive for a false positive).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'Vulnerability id' },
      status: { type: 'string', enum: ['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'] },
      severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
      evidence: { type: 'string' },
      confidence: { type: 'number' },
      gained: { type: 'string', description: 'What privilege/result this vulnerability yielded (short score-caliber labels, separate multiple items with commas)' },
      title: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.updateVuln(id, args.id, { status: args.status, severity: args.severity, evidence: args.evidence, confidence: args.confidence, gained: args.gained, title: args.title })
      return JSON.stringify({ ok: result.updated, engagement: id, ...result, stats: store.vulnStats(id) }, null, 2)
    },
  })))

  /* ================================================================== 漏洞利用 / 内网渗透 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_add',
    description: 'Record a credential (exploitation / internal penetration role). **You must write the password/key plaintext into secret_value** — the panel displays plaintext directly for reuse at any time; at the same time point secret_ref at the evidence file under runs/. Note: this library is local only; never commit the library file or exported content to any repository.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      host: { type: 'string', required: true, description: 'Owning host (IP or domain)' },
      username: { type: 'string' },
      secret_type: { type: 'string', description: 'password | hash | key | token | connection-string, default password' },
      secret_value: { type: 'string', description: '[Required] Credential plaintext: password / Hash / private key / Token / connection string' },
      secret_ref: { type: 'string', description: 'Evidence reference path, e.g. runs/cred-vnc-10.0.0.5.txt' },
      privilege: { type: 'string', description: 'Privilege level of this credential, e.g. admin / user / db-read' },
      asset_id: { type: 'number' },
      source: { type: 'string', description: 'Source: exploit / dump / config-leak …' },
      tool: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addCredential(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_add',
    description: 'Register an evidence screenshot: copy the image into the target directory and associate it with a score point/hit (the panel shows the image when the score point is expanded, and the report embeds it too). For batch score points (such as endpoint privileges) each score point shows at most 3 representative images, so there is no need to screenshot every machine.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      path: { type: 'string', description: 'Path of the image on this machine (relative to the target directory or absolute); choose one of this and data_base64' },
      data_base64: { type: 'string', description: 'Image content (base64, may carry a data: prefix); use this when the screenshot tool did not write to disk' },
      label: { type: 'string', description: 'Image caption, e.g. "domain controller WEB-SHDC1 atexec shows nt authority\\\\system"' },
      kind: { type: 'string', description: 'screenshot (live screenshot, default) | card (evidence excerpt card generated from the record, marked as such in the report)' },
      point_code: { type: 'string', description: 'Associated score point code, e.g. terminal-access / central-system' },
      hit_id: { type: 'number', description: 'Associate with a specific score hit (score_hit id); with it the image hangs only on that one' },
      asset_id: { type: 'number' },
      target: { type: 'string', description: 'Target this image corresponds to (IP / URL)' },
      note: { type: 'string', description: 'Note: what this image proves' },
      source_ref: { type: 'string', description: 'Original source: the screenshot\'s on-disk path or an evidence file under runs/' },
      captured_at: { type: 'string', description: 'Screenshot time (ISO); defaults to the current time' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addShot(id, { ...args, engagement: undefined, agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_list',
    description: 'List registered evidence screenshots (with owning score point, target, type, on-disk file).',
    parameters: {
      engagement: { type: 'string' },
      point_code: { type: 'string' },
      hit_id: { type: 'number' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, ...store.listShots(id, {
        point_code: args.point_code, hit_id: args.hit_id, asset_id: args.asset_id,
      }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_shot_delete',
    description: 'Delete an evidence screenshot (together with the disk file).',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'shot id (the id returned by redteam_shot_list)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: eng, ...store.deleteShot(eng, args.id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_credential_list',
    description: 'List collected credentials (including plaintext secret_value), for credential reuse and lateral movement.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
      username: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listCredentials(id, { host: args.host, username: args.username }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_add',
    description: 'Record a successfully obtained access session (a lateral movement starting point). method e.g. vnc/rdp/ssh/web-shell/webshell/db; privilege e.g. admin/user/system.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string', required: true },
      username: { type: 'string' },
      method: { type: 'string', required: true, description: 'How access was obtained' },
      privilege: { type: 'string' },
      asset_id: { type: 'number' },
      session_ref: { type: 'string', description: 'Session/evidence reference, e.g. runs/session-vnc-10.0.0.5.md' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAccess(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_access_list',
    description: 'List obtained access sessions.',
    parameters: {
      engagement: { type: 'string' },
      host: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listAccess(id, { host: args.host }) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_role_prompt_reset',
    description: 'Restore role system prompts to the built-in default (new template). Use it when an old target should get the latest role prompts; when role is omitted all four roles are reset.',
    parameters: {
      engagement: { type: 'string' },
      role: { type: 'string', /* 角色白名单**从 ROLE_ORDER 派生**：写死 4 个值曾漏掉 assess，
          而预设明确要求主会话用本工具取资产梳理角色的提示词 —— 结果 enum 直接拒绝，
          资产梳理子智能体永远拿不到角色约束。派生后新增角色不会再漏。 */
      enum: ROLE_ORDER },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.resetPrompts(id, args.role)
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ---------- WebShell 与内网隧道：打的过程中随时复用，避免"Forgot that entry points still existed later on" ---------- */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_sessions',
    description: '[Look at this before and after every decision] One-screen overview of every currently reusable entry point: online WebShells, usable internal tunnels (with listen address and reachable subnets), credentials, access sessions, plus online/offline statistics. Before attacking the internal network look here — do not reinvent the wheel and do not forget the tunnels you already have.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const summary = store.sessionSummary(id)
      return JSON.stringify({
        ok: true, engagement: id, totals: summary.totals,
        webshells: summary.webshells.map((w) => ({
          id: w.id, url: w.url, type: w.shell_type, pass_key: w.pass_key, privilege: w.privilege,
          status: w.status, asset_ip: w.asset_ip, last_check: w.last_check, note: w.note,
        })),
        tunnels: summary.tunnels.map((t) => ({
          id: t.id, kind: t.kind, listen: t.listen, entry: t.entry, reach: t.reach,
          entry_kind: t.entry_kind, legit: t.legit,
          status: t.status, asset_ip: t.asset_ip, command: t.command, last_check: t.last_check, note: t.note,
        })),
        hint: 'When a tunnel\'s status=active you can hand it straight to a scanner: -socks5 <listen> or --proxy socks5://<listen>; when webshell status=online connect with the corresponding client.'
          + ' Note: legit=false (entry_kind=self-only, only on your own VPS/self-hosted server) **does not cross the target boundary and is not a breach**; legit=null means entry_kind was never declared — use redteam_tunnel_update to add the target-side end.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_add',
    description: 'Register a WebShell that is already online. **You must upload an encrypted Behinder or Godzilla shell** — the user connects directly with the matching client in the console, and one-liner shells / self-built shells / MemShells cannot be connected by the user, so they do not count as a deliverable entry point. shell_type accepts only godzilla | behinder; when another form truly has to be used, fill other and explain why in note. Registering the same url+pass_key again merges and refreshes. After registration every role agent can reuse it — do not re-compromise the same point.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      url: { type: 'string', required: true, description: 'Full WebShell URL' },
      shell_type: { type: 'string', description: 'godzilla (Godzilla) | behinder (Behinder); other forms use antsword/other with an explanation' },
      pass_key: { type: 'string', description: 'Connection password / key (write pass for a Behinder shell, key for a Godzilla shell)' },
      privilege: { type: 'string', description: 'Current privilege, e.g. www-data / root / iis' },
      secret_ref: { type: 'string', description: 'Credential/evidence reference, e.g. runs/ws-10.0.0.5.txt (do not write plaintext passwords into the library)' },
      asset_id: { type: 'number' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addWebshell(id, { ...args, engagement: undefined, status: 'online', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_list',
    description: 'List registered WebShells (with online status and last check time).',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'online | offline | unknown' },
      asset_id: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listWebshells(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_webshell_update',
    description: 'Update WebShell state (deleted/offline/privilege change) or add a note.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true, description: 'WebShell record id' },
      status: { type: 'string', description: 'online | offline | dead | unknown' },
      privilege: { type: 'string' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateWebshell(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_add',
    description: '登记一条内网隧道。**打进内网必须先用技能 suo5-tunnel 通过 WebShell/HTTP 建 socks5（kind=suo5）**；没有隧道就不要手搓内网探测脚本。listen 写本机可用地址（如 127.0.0.1:1080），reach 写它能到达的网段。登记后扫描器可直接 -socks5 <listen>。\n\n**红线：自己的 VPS / 自己配置的服务器不算隧道。** 只在你自己服务器上开的 socks5、frp 服务端、代理，没有碰到目标，**不算跨越靶标边界、不算边界突破或内网突破**（这类填 entry_kind=self-only，会被标成"不算突破"）。**必须说清目标侧的那一端**：\n· target-outbound — 目标主动连出到我方（**自己服务器收目标反弹 shell**、目标上跑 frp/Stowaway 客户端）；\n· target-http — 经目标 WebShell/HTTP 通道（suo5、Neo-ReGeorg、reGeorg）；\n· target-agent — 经目标已控进程/会话转发（SSH -R 由目标发起等）。',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      kind: { type: 'string', required: true, description: 'suo5 (preferred, goes over WebShell/HTTP) | socks5 | ssh-r | frp | chisel | other' },
      listen: { type: 'string', required: true, description: 'Local listen address host:port' },
      entry: { type: 'string', description: 'Entry: WebShell URL / jump host / command' },
      reach: { type: 'string', description: 'Reachable subnet, e.g. 10.0.0.0/8' },
      entry_kind: { type: 'string', description: '[Important] What sits on the target side of the channel: target-outbound (target reverse shell to us / frp client running on the target) | target-http (through the target WebShell\'s suo5/Neo-ReGeorg) | target-agent (forwarded through an already controlled process on the target) | self-only (only on your own VPS/self-hosted server, **not a breach**)' },
      webshell_id: { type: 'number', description: 'Established by which WebShell' },
      asset_id: { type: 'number' },
      command: { type: 'string', description: 'Setup command, for easy rebuilding' },
      pid: { type: 'string' },
      note: { type: 'string' },
      found_by_agent: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addTunnel(id, { ...args, engagement: undefined, status: 'active', agent: agentOf(args) })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_list',
    description: 'List registered internal tunnels (with status, listen address, reachable subnets, entry_kind and legit judgment). **legit=false means the channel is opened only on your own VPS/self-hosted server and does not cross the target boundary or count as a breach**; legit=null means entry_kind was not declared.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'active | down | unknown' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listTunnels(id, args) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_tunnel_update',
    description: 'Update tunnel state (closed/dead/listen address changed) or add the entry_kind judgment. Once a tunnel is no longer needed, always mark it down and explain, to avoid later misuse. **For old records that never declared entry ownership (legit=null, shown as "pending confirmation" in the UI), add the target-side end with entry_kind** — only then does it count as breach evidence.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', required: true },
      status: { type: 'string', description: 'active | down | closed | unknown' },
      listen: { type: 'string' },
      reach: { type: 'string' },
      entry: { type: 'string', description: 'Entry: WebShell URL / jump host / command' },
      entry_kind: { type: 'string', description: 'Supplementary declaration of the target-side end: target-outbound | target-http | target-agent | self-only (only on your own server, not a breach)' },
      note: { type: 'string' },
      check_note: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const eng = resolveEngagement(store, exec, args.engagement)
      const result = store.updateTunnel(eng, args.id, args)
      return JSON.stringify({ ok: true, engagement: eng, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_session_check',
    description: 'Test the connectivity of all WebShells and tunnels for real (the host side actually initiates HTTP / TCP connections) and write the online/offline state back to the database. Run it once before starting work and once after long tasks.',
    parameters: {
      engagement: { type: 'string' },
      timeoutMs: { type: 'number', description: 'Single probe timeout, default 6000ms' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = await store.probeSessions(id, { timeoutMs: args.timeoutMs })
      const online = result.webshells.filter((w) => w.status === 'online').length
      const active = result.tunnels.filter((t) => t.status === 'active').length
      return JSON.stringify({
        ok: true, engagement: id, checked_at: result.checkedAt,
        summary: `WebShell online ${online}/${result.webshells.length}, tunnels usable ${active}/${result.tunnels.length}`,
        webshells: result.webshells, tunnels: result.tunnels,
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_path',
    description: 'Export the attack graph: asset topology + vulnerability nodes + controlled assets (meta.owned). Used for lateral movement path planning and results reporting. When there are too many nodes, narrow the range with cidr.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      maxNodes: { type: 'number', description: 'Default 400' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const maxNodes = Math.min(Number(args.maxNodes) || 400, 1500)
      const graph = store.attackGraph(id, { cidr: args.cidr })
      if (graph.nodes.length > maxNodes) {
        return JSON.stringify({
          ok: false,
          error: 'Too many graph nodes (' + graph.nodes.length + ' > ' + maxNodes + '), please specify cidr to narrow the range',
          summary: graph.summary,
        }, null, 2)
      }
      return JSON.stringify({
        ok: true, engagement: id, summary: graph.summary,
        owned: graph.nodes.filter((n) => n.meta && n.meta.owned).map((n) => n.label),
        nodes: graph.nodes, edges: graph.edges,
      }, null, 2)
    },
  })))

  /* ================================================================== 域名 / Web 资产 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_web_list',
    description: 'List web assets (with directly reachable URLs and page titles). Before web penetration look here and prefer starting from APIs.',
    parameters: {
      engagement: { type: 'string' },
      cidr: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listWeb(id, { cidr: args.cidr, limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id, total: result.total,
        items: result.items.map((w) => ({
          url: w.url || ('http' + (w.port === 443 || w.port === 8443 || w.port === 9443 ? 's' : '') + '://' + w.ip + (w.port === 80 || w.port === 443 ? '' : ':' + w.port)),
          title: w.title, ip: w.ip, segment: w.segment_cidr, port: w.port,
          service: [w.service, w.product, w.version].filter(Boolean).join(' '),
          provenance: w.provenance, asset_id: w.asset_id,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_domain_index',
    description: 'Aggregate assets by domain: which IPs/assets each domain maps to. Used to sort out the relationship between the primary domain, subdomains and C blocks.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.domainIndex(id) }, null, 2)
    },
  })))

  /* ================================================================== 得分目标 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_list',
    description: 'View the scoring target panel: all score points (name/category/points/whether captured/hit evidence) and overall progress. **Look here before planning every next step** and decide what to attack first by point value.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.listScorePoints(id, {})
      /* 按合并版的 8 个类别分组返回：智能体一眼看到"Which categories are still unattacked and how much of each item's cap is used" */
      const groups = (result.ruleGroups || []).map((g) => ({
        category: g.name,
        items: g.tiers.length,
        points: g.points,
        cap_sum: g.capSum,
      }))
      return JSON.stringify({
        ok: true, engagement: id, summary: result.summary,
        groups,
        items: result.items.map((p) => ({
          id: p.id, code: p.code, name: p.name, category: p.category, points: p.points,
          /* 合并版的档位说明（一条含多档时，记分要用 points 参数指定本档分值） */
          tier: p.tier, cap: p.cap, cap_used: p.cap_used, dedup_scope: p.dedup_scope,
          scope_label: p.scope_label,
          enabled: p.enabled, achieved: p.hits.length > 0, hits: p.hits.length,
          counted: p.counted, earned: p.earned,
          /* 该条因计分口径 / 已达上限而不计分的条数（把它当停止信号，别在同一条上刷） */
          capped: p.capped,
          /* 两个字段各司其职：service_summary 是"Why this entry has a hit but scores nothing"的整段说明；
             capped_reason 留给**逐条命中**的具体原因（在 hits[] 里），不要拿摘要冒充它。 */
          capped_summary: p.service_summary,
          evidence: p.hits.map((h) => (h.target ? h.target + '：' : '') + h.evidence).slice(0, 3),
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_hit',
    description: 'Record a score. The scoring rules have been restructured following the "Breach Intrusion Scoring Rules (merged edition)" into **25 items** (I. Obtaining privileges 21 items + II. Breaching the network boundary 4 items, 8 categories in total),'
      + 'There are also 8 general rules G1–G8 that cut across all entries. **Before recording a score, read the actual code and that entry\'s cap/caliber with `redteam_score_list`** — do not write from memory.\\n\\n'
      + '**Evidence records results only**: target asset + what was obtained (account/password/privilege/data volume); do not write the acquisition process or path — the process is the job of the attack score chain steps.'
      + 'Whenever it can point to "which vulnerability was used", include vuln_id and the report attaches that vulnerability\'s raw request automatically.\\n\\n'
      + '**Multi-tier entries use `points` to specify this tier\'s value**: the merged edition collapses several tiers of the same item into one (e.g. "server host privileges" normal 10 / administrator 50,'
      + '"domain control privileges" first-level 50 / second-level 20, "network device privileges" normal 100 / administrator 200). When recording a score set `points` to the value of the tier actually achieved;'
      + 'When omitted the entry\'s main-tier default is used. **The same system is counted only once at its highest privilege** (G1) — if the normal tier was recorded first and it was later escalated to the administrator tier,'
      + 'Record one more administrator-tier entry (set points to the higher tier value); the system automatically supersedes the normal-tier one.\\n\\n'
      + '**Red line one: account-type scores require an actual login test first.** After obtaining an account/password you must use a browser (browser-automation / kimi-webbridge) or an equivalent session'
      + 'Only when login is actually tested and pages can be accessed interactively do you record account privilege points — **credentials alone do not mean the account is obtained**; write failed logins into the `test` parameter of redteam_asset_test.\\n\\n'
      + '**Red line two: self-registered accounts do not count as scored privileges.** Self-service signups, users/roles/backend accounts you created yourself, and permissions you granted yourself do not count —'
      + 'Drill scores target accounts and privileges **obtained that already belonged to someone else**. Record such cases with self_created=true (keeping the process); they score nothing, count nothing and never enter the report.\\n\\n'
      + '**Red line three: mind this entry\'s scoring caliber (G1/G3).** Every score point carries its own caliber:'
      + '`the same system counts only once at its highest privilege` / `the same service counts only the highest entry` / `the whole target counts only once` (breaching the network boundary) / `accumulated per machine · card · unit` (endpoints, cloud nodes, compute cards).'
      + 'and each has its own **cap** (e.g. server host 600 points, web application 2000 points, centralized system 4000 points); once the cap is reached the same entry stops accumulating (G3) —'
      + 'The response uses warning to tell you "cap reached / already superseded" — treat it as a **stop signal**, and switch to another entry or another asset instead of farming the same one.\\n\\n'
      + '**Data results are scored separately (G2)**: mail data, business data, data assets and the like are recorded separately by importance and never mixed into privilege scores;'
      + 'evidence must state the **actual data volume** (e.g. "exported 1,320,000 user records").',
    parameters: {
      engagement: { type: 'string' },
      code: { type: 'string', description: 'Score point code (or any one of point_id / point_name); check the actual code with redteam_score_list first' },
      point_id: { type: 'number' },
      point_name: { type: 'string' },
      points: { type: 'number', description: '[Required for multi-tier entries] Which tier this hit scores as (e.g. server host privileges: 10 for normal privilege, 50 for administrator; domain control: 50 for first-level, 20 for second-level). When omitted the entry\'s main-tier default is used.' },
      target: { type: 'string', description: 'Target asset: URL / ip:port / hostname (**include the port**; service/system caliber is judged by it)' },
      asset_id: { type: 'number', description: 'Id of the target asset in the library' },
      port: { type: 'number', description: '[Recommended] Which port this score lands on (caliber is judged by "asset + port"; when target already carries the port this can be omitted)' },
      vuln_id: { type: 'number', description: '[Recommended] Which vulnerability earned the score (the report attaches the raw request accordingly)' },
      step_id: { type: 'number', description: 'Corresponding attack chain step id (optional)' },
      evidence: { type: 'string', required: true, description: '[Required] Result: what you obtained, e.g. "backend admin tomcat/Tomcat@2024 (browser login actually tested)", "database account root/xxx", "exported 1.32 million user records". For multi-tier entries state the tier (e.g. "administrator privilege").' },
      self_created: { type: 'boolean', description: '[Important] Is this account/privilege **self-registered, self-created**? If so fill true — it only records the process, scores nothing and never enters the report. Do not fill this for accounts/privileges obtained that already belonged to someone else (default false).' },
      note: { type: 'string' },
      recorded_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addScoreHit(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_point_save',
    description: 'Add or modify a score point (points/name/category/description/enabled). Users also edit them in the UI; agents use it only when necessary (e.g. discovering score items in the rules that are not yet recorded). With id it is a modification, without id it is an addition.',
    parameters: {
      engagement: { type: 'string' },
      id: { type: 'number', description: 'Existing score point id (pass it on modification)' },
      name: { type: 'string', required: true },
      code: { type: 'string', description: 'Short code (recommended when adding, makes scores easier to record)' },
      category: { type: 'string', description: 'Category, e.g. account privileges / server privileges / database / network breach / data / core target' },
      points: { type: 'number', description: 'Points' },
      description: { type: 'string', description: 'Scoring condition description' },
      enabled: { type: 'boolean' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.saveScorePoint(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_assess',
    description: 'Run an "ease of compromise" assessment on an asset: which results are expected (account privileges/RCE/server privileges/database privileges/sensitive data/boundary breach), how high the priority is, and the reasoning. Call it once per asset when recon wraps up, so the commander can rank by cost-effectiveness.',
    parameters: {
      engagement: { type: 'string' },
      asset_id: { type: 'number' },
      ip: { type: 'string' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'high easy results / medium average / low hard to compromise or low value' },
      potential: { type: 'string', description: 'Expected results, e.g. "account privileges+RCE", "database privileges", "large amounts of sensitive information"' },
      reason: { type: 'string', description: 'Reasoning: the fingerprint version hits an Nday, API not authenticated, weak password, exposed database, WAF strength, etc.' },
      assessed_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.assessAsset(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  /* ================================================================== 证据 / 攻击链 / 报告 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_http_evidence_add',
    description: 'Save one piece of HTTP evidence: raw request and response. The report renders it as a raw message you can paste into Burp Suite / Yakit, so request must be the complete replayable raw request (request line, headers such as Host, and body when needed).',
    parameters: {
      engagement: { type: 'string' },
      vuln_id: { type: 'number', description: 'Associated vulnerability id (recommended)' },
      asset_id: { type: 'number' },
      label: { type: 'string', description: 'Purpose of this evidence, e.g. "IDOR read of the user list"' },
      method: { type: 'string', description: 'GET/POST/…' },
      url: { type: 'string' },
      status: { type: 'number', description: 'Response status code' },
      request: { type: 'string', required: true, description: 'Full raw request text (paste straight into Burp)' },
      response: { type: 'string', description: 'Full response or key fragment' },
      note: { type: 'string' },
      captured_by: { type: 'string', description: 'Collection role' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addHttpEvidence(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain_add',
    description: 'Record an attack chain step. **The report\'s "how this step came about" rests entirely on this record**: how the account password was obtained, how the Behinder shell was uploaded, how the tunnel was built — all of it must be written here with `tool` (exact command text) + `detail` (why it was done, where the lead came from) + `result` (actual output/result). The attack chain page and the report display everything in seq order.',
    parameters: {
      engagement: { type: 'string' },
      agent: AGENT_PARAM,
      stage: { type: 'string', required: true, enum: ['recon', 'vuln', 'exploit', 'access', 'pivot', 'data', 'other'], description: 'Action type (compatibility field): recon information gathering | vuln vulnerability discovery | exploit exploitation | access obtaining privileges | pivot internal network breach | data sensitive data | other. **Use stage_code for stage attribution**; this field is only a fallback for old data.' },
      title: { type: 'string', required: true, description: 'One sentence describing what this step did, e.g. "uploaded a Behinder shell through the backend template upload point", "built a socks5 tunnel with suo5"' },
      detail: { type: 'string', description: 'Why it was done this way and where the lead came from, e.g. "login page leaks version Coremail XT 5.0 → matched CVE-2023-xxxx → backend template management allows upload"' },
      tool: { type: 'string', description: '[Key for report reproduction] **The exact text of the command actually executed**, e.g. `nuclei -t CVE-2021-xxxx.yaml -u http://x`, `suo5-linux-amd64 -t http://x/shell.jsp -l 1080`, `sqlmap -u "http://x?id=1" --dump`. Without it this step cannot be reproduced in the report.' },
      result: { type: 'string', description: '[Key for report reproduction] Actual result/output summary, e.g. `uid=0(root) gid=0(root)`, "returned 200 with 12,000 user records", "backend admin tomcat logged in successfully"' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      access_id: { type: 'number' },
      evidence_ref: { type: 'string', description: 'Evidence file/session reference, e.g. runs/session-vnc.md' },
      recorded_by: { type: 'string' },
      point_code: { type: 'string', description: '[Fill this when the step scored] Score point code (e.g. rce / webshell / boundary); the server records a score automatically and links the step and the score to each other. **evidence must be supplied at the same time, otherwise no score is recorded** (the step is still stored).' },
      stage_code: { type: 'string', enum: ['recon', 'internet', 'boundary', 'internal', 'target'], description: 'Combat stage this belongs to (only these 5 legal values): recon (information gathering) | internet (internet asset privileges) | boundary (boundary breach · tunnel setup) | internal (internal network asset privileges) | target (target system privileges). Any other value (such as the external/foothold/tunnel/privilege common in external tools) is ignored and falls back to stage, so the step lands in no stage.' },
      evidence: { type: 'string', description: 'Used together with point_code: what this score obtained (target asset + account/privilege/data volume) — **no fill, no score**.' },
      self_created: { type: 'boolean', description: 'Used together with point_code: is the account/privilege obtained at this step **self-registered/self-created**? If so true (process only, no score)' },
      target: { type: 'string', description: 'Used together with point_code: target asset' },
      seq: { type: 'number', description: 'When omitted it is appended to the end of the chain' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addChainStep(id, { ...args, engagement: undefined, agent: agentOf(args), recorded_by: args.recorded_by || args.agent })
      /* 步骤落库后提醒两件事：报告要用的 tool/result 有没有写、这一步的得分有没有记 */
      const hints = []
      if (!args.tool) hints.push('This step did not record `tool` (the actual command): the report\'s "how it was done" will be blank — add a step with the command written down.')
      if (!args.result) hints.push('This step did not record `result` (the actual output/result): report reproduction will lack the evidence of "whether it worked".')
      if (result && result.score_hint) hints.push(result.score_hint)
      return JSON.stringify({ ok: true, engagement: id, ...result, hints: hints.length > 0 ? hints : undefined }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_chain',
    description: 'Read the full attack chain (in step order); used for reporting and for checking whether the chain is closed (entry → privilege → internal network breach).',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      return JSON.stringify({ ok: true, engagement: id, items: store.listChain(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_add',
    description: 'Save an **actually working** attack file (script/POC/EXP/wordlist) into the target folder for reuse and delivery. Directory structure: attack-files/<IP|URL host|C block>/<filename>. evidence is required and must state the verification effect (e.g. "shows uid=0", "unauthenticated request returns 200 with data") — **do not put scripts here that never worked or were only attempted**.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', required: true, description: 'Target: IP, URL or C block (multiple ports of the same IP go into that IP\'s folder)' },
      name: { type: 'string', required: true, description: 'Filename, e.g. cve-2021-22893.sh / vnc_brute.py' },
      kind: { type: 'string', enum: ['poc', 'exp', 'script', 'wordlist', 'other'], description: 'Type: poc verification / exp exploitation / script script / wordlist wordlist' },
      description: { type: 'string', description: 'What this file does (one sentence)' },
      evidence: { type: 'string', required: true, description: 'Effectiveness evidence: the output/echo/impact actually obtained, or the corresponding vulnerability/evidence id' },
      content: { type: 'string', description: 'File content (choose one of this and path)' },
      path: { type: 'string', description: 'Path of an existing file (relative to the target directory or absolute), which is copied into the target folder (choose one of this and content)' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      created_by: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.addAttackFile(id, { ...args, engagement: undefined })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_file_list',
    description: 'List saved attack files (grouped by target folder). Before attacking a target look here to avoid reinventing the wheel.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: 'Only a single target' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      if (args.target) return JSON.stringify({ ok: true, engagement: id, items: store.listAttackFiles(id, { target: args.target }) }, null, 2)
      return JSON.stringify({ ok: true, engagement: id, folders: store.attackFileTree(id) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report_targets',
    description: '[Deprecated, use redteam_score_report] View results reports by target (one per IP / URL / C block): result findings (including raw requests you can paste into Burp/Yakit), obtained privileges, credentials, attack files, attack chain. Use it to report by target or to check what a target still lacks.',
    parameters: {
      engagement: { type: 'string' },
      target: { type: 'string', description: 'Report for a single target only' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.reportTargets(id, {})
      const picked = args.target ? result.targets.filter((t) => t.key === args.target || t.label === args.target) : result.targets
      return JSON.stringify({
        ok: true, engagement: id, generated_at: result.generated_at, totals: result.totals,
        targets: picked.map((t) => ({ key: t.key, label: t.label, segment: t.segment, stats: t.stats })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_attack_chain',
    description: 'Attack chain: five stages strung together by attack surface position — ① information gathering (internet side) → ② internet asset privileges → ③ boundary breach (tunnel setup) → ④ internal network asset privileges → ⑤ target privileges. Returns each stage\'s objective, **how many points were actually earned and the cumulative total**, the assets involved, and the real tunnel of the boundary breach stage. At the start of work use it to state plainly "which stage we are in now and which stage to attack next"; report conclusions by stage.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const chain = store.scoreChain(id)
      return JSON.stringify({
        ok: true, engagement: id,
        totals: { points: chain.summary.points, totalPoints: chain.summary.totalPoints, hits: chain.summary.hits,
          /* 按服务封顶（同资产同端口只算一次）而没计分的条数：账号类/数据库权限 */
          serviceCappedHits: chain.summary.serviceCappedHits || 0 },
        stages: (chain.stages || []).map((st) => ({
          code: st.code, name: st.name, goal: st.goal,
          points: st.points, cumulative: st.cumulative, counted: st.counted, hits: st.hits,
          steps: st.steps, tools: st.tools,
          methods: (st.sections || []).map((x) => x.label + '：' + (x.items || []).join('、')),
          scored: st.items.map((x) => ({ point: x.point_name, points: x.points, counted: x.counted, target: x.target,
            service: x.service || null, capped: x.capped === true, capped_reason: x.capped_reason || null })),
          assets: (st.assets || []).map((a) => a.ip + (a.scope === 'internal' ? '(internal)' : '(external)') + ' contributed' + a.points + 'pts'),
          tunnels: (st.tunnels || []).map((t) => t.kind + ' ' + t.listen + ' [' + t.status + '] reachable ' + (t.reach || '—')),
        })),
        hint: 'The scoring stage is derived automatically (core-system→target system, boundary→boundary breach, the rest by the asset\'s internal/external attribution); when writing attack chain steps include stage_code (only recon/internet/boundary/internal/target are accepted) or the step is not counted toward the correct stage, and any other value is ignored. Account privileges and database privileges are capped per "same asset, same port": once one service yields the highest privilege that point is maxed out, and a repeated hit on the same service is marked capped=true and scores nothing.',
      }, null, 2)
    },
  })))


  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_score_report',
    description: 'Attack score chain reproduction report: only results that "earned points" are included (findings that scored nothing stay out), and every item carries, as far as possible, the raw request you can paste straight into Yakit Repeater to reproduce. Use this when a deliverable report is needed, not redteam_report.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: 'Maximum number of items, default 500' },
      markdown: { type: 'boolean', description: 'true = return the full markdown (default true); false = return only the entry summaries' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const r = store.scoreReport(id, { limit: args.limit })
      if (args.markdown === false) {
        return JSON.stringify({ ok: true, engagement: id, summary: r.summary,
          items: r.items.map((x) => ({ seq: x.seq, point: x.point_name, points: x.points, counted: x.counted,
            target: x.target, gained: x.gained, requests: x.requests.length, missing_evidence: x.missing_evidence })) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, summary: r.summary, markdown: r.markdown }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_report',
    description: '[Deprecated, use redteam_score_report] Generate a results report (Markdown): only **verified/exploited findings at medium severity or above** are included (each with the raw request you can paste into Burp/Yakit), plus the attack chain, obtained privileges and credentials, and remediation advice. The asset inventory from recon, pending/false-positive items, and low/info-level findings never appear in the report. To get a finding into the report: first set it to confirmed (verification passed) or exploited (exploitation succeeded) with redteam_vuln_update, then add the raw request with redteam_http_evidence_add.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = store.report(id)
      return JSON.stringify({ ok: true, engagement: id, generated_at: result.generated_at, stats: result.stats, markdown: result.markdown }, null, 2)
    },
  })))

  /* 开源版下架知识库：保留工具名，执行一律返回关闭。 */
  const KB_DISABLED = JSON.stringify({ ok: false, error: 'The open source edition has removed the knowledge base', disabled: true }, null, 2)

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_search',
    description: '[First step before attacking an Nday/1day] Check the "ready-made" two layers first: ① **knowledge base** (general POC/EXP accumulated on this machine, shared across targets, sorted by "verified → reuse count") ② **local nuclei template library** (tens of thousands of templates, hit directly by CVE/component name). On a hit, take it: fetch the full text from the knowledge base with redteam_poc_get, or run the template directly with `nuclei -t <relative path>`. **Do not go back to the internet or hand-craft it again.** Only when neither layer has it, search the internet or hand-craft it, and once it is verified to work, backfill the knowledge base with redteam_poc_add.',
    parameters: {
      q: { type: 'string', description: 'Keyword: component+version, vulnerability name, path fragment, or a characteristic string in the body' },
      cve: { type: 'string', description: 'CVE / CNVD id, e.g. CVE-2023-21839' },
      component: { type: 'string', description: 'Component/product name, e.g. Weblogic, Shiro, Weaver OA (泛微 OA), Nacos' },
      kind: { type: 'string', description: 'poc | exp | script | template | payload' },
      category: { type: 'string', description: 'Filter by **category** (multiple values allowed, comma separated): rce | deserialization | file-upload | sqli | unauthorized | auth-bypass | weak-password | ssrf | xxe | path-traversal | info-leak | privesc | tunnel | other' },
      engagement: { type: 'string', description: 'Filter by **source target** (target id or name keyword): only look at experience "verified on a certain organization"' },
      asset_target: { type: 'string', description: 'Filter by **discovered asset** (IP / domain / URL fragment)' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web (internet) | self (hand-crafted) | manual (manual) | nuclei-template' },
      verified: { type: 'boolean', description: 'true to see only tested-and-verified items (prefer these)' },
      templateLimit: { type: 'number', description: 'Maximum number of local nuclei templates to return, default 20' },
      limit: { type: 'number', description: 'Knowledge base entry cap, default 200' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      const q = args.q || args.cve || args.component || ''
      /* templateStats() / nucleiTemplatesDir() 都要扫模板目录：**一次调用只算一次**。
         原来这一小段里 templateStats() 被连着算了三遍（13k 模板的目录每次都要走一遍）。 */
      const tplStats = store.templateStats()
      const tpl = (q || args.category)
        ? store.searchTemplates(q, Math.min(Number(args.templateLimit) || 20, 100), 0, args.category || '')
        : { dir: tplStats.dir || store.nucleiTemplatesDir() || null, total: tplStats.total, items: [], byCategory: tplStats.byCategory }
      const hit = items.length > 0 || (tpl.items || []).length > 0
      return JSON.stringify({
        ok: true,
        knowledge_base: {
          total: stats.total, verified: stats.verified, reused: stats.reused,
          /* 归类概览：让智能体知道"How many of which kind of weapon are already amassed"，缺哪类心里有数 */
          by_category: (stats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n + '(verified ' + c.verified + '）'),
          by_engagement: (stats.byEngagement || []).slice(0, 10).map((e) => e.engagement + ' ' + e.n),
        },
        local_templates: {
          dir: tplStats.dir, total: tplStats.total, cve_templates: tplStats.cve, matched: (tpl.items || []).length,
          by_category: (tplStats.byCategory || []).filter((c) => c.n > 0).map((c) => c.name + ' ' + c.n),
        },
        count: items.length,
        hint: hit
          ? 'On a ready-made hit: fetch the full text of a knowledge base entry with redteam_poc_get; run a nuclei template directly with `nuclei -t <template relative path>`. After use, record one reuse with redteam_poc_use.'
          : 'Neither the knowledge base nor the local template library has it: search the internet (web_search / GitHub / ExploitDB / vendor advisories) or hand-craft it, and once verified be sure to backfill the knowledge base with redteam_poc_add (with category + engagement + asset_target + verified_note).',
        templates: (tpl.items || []).map((t) => ({ path: t.path, name: t.name, severity: t.severity, tags: t.tags })),
        items: items.map((x) => ({
          id: x.id, code: x.code, title: x.title, kind: x.kind, category: x.category, cve: x.cve, component: x.component,
          versions: x.versions, language: x.language, source: x.source, source_url: x.source_url,
          verified: x.verified === 1, verified_note: x.verified_note, hit_count: x.hit_count,
          /* 来源溯源：哪条经验、哪个靶标、哪台资产、什么时候建的 */
          engagement: x.engagement_name || x.engagement_id || null, asset_target: x.asset_target || null,
          found_by_agent: x.found_by_agent || null, created_at: x.created_at,
          tags: x.tags, usage: x.usage, path: x.path, has_content: x.has_content === 1,
        })),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_get',
    description: 'Fetch the **full content** of a knowledge base POC/EXP (body + usage + verification records + on-disk path), ready to use as-is or adapt into a target-specific script. When id is not passed you can use code (the code field in the redteam_poc_search result).',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry id' },
      code: { type: 'string', description: 'Stable identifier of a knowledge base entry (the code in the search result)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const row = store.getPoc(args.id !== undefined ? args.id : args.code)
      if (row === undefined) return JSON.stringify({ ok: false, error: 'The knowledge base does not have this entry (search first with redteam_poc_search)' }, null, 2)
      return JSON.stringify({ ok: true, ...row }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_add',
    description: 'Store **generally reusable** POC/EXP into the knowledge base (shared across targets). Anything taken from the internet, hand-crafted yourself, or already debugged and verified goes here — record only what truly works, and state the source and the verification evidence. Judgment rule: whatever **still works on a different target** goes into the knowledge base; scripts valid only for the current target go to redteam_attack_file_add (the attack files page). The same name (same code) merges and refreshes, which you can use to update a version.\\n\\n**Backfill triad (without it the panel has no category and the source cannot be traced)**: ① `category` classification; ② `engagement` + `asset_target` — on which target and which asset this knowledge was discovered and verified; ③ `verified` + `verified_note` verification evidence.',
    parameters: {
      title: { type: 'string', required: true, description: 'Title: component + vulnerability name/id, e.g. "Weblogic T3 deserialization CVE-2023-21839"' },
      kind: { type: 'string', description: 'poc (verification) | exp (exploitation) | script | template | payload' },
      category: { type: 'string', description: '[Category, recommended and normally required] rce remote command execution | deserialization | file-upload file upload getshell | sqli SQL injection | unauthorized unauthorized access | auth-bypass auth bypass/IDOR | weak-password weak credentials | ssrf | xxe | path-traversal directory traversal/arbitrary file read | info-leak information disclosure | privesc privilege escalation/lateral movement | tunnel tunnel/proxy | other' },
      cve: { type: 'string', description: 'CVE / CNVD id' },
      component: { type: 'string', description: 'Component/product name (eases searching by component)' },
      versions: { type: 'string', description: 'Affected version range' },
      severity: { type: 'string', description: 'critical | high | medium | low' },
      language: { type: 'string', description: 'python | go | java | bash | http | nuclei | js | php' },
      source: { type: 'string', description: 'web (scraped from the internet) | self (hand-crafted) | manual (manual) | nuclei-template' },
      source_url: { type: 'string', description: 'Source link (required for internet sources, eases review)' },
      description: { type: 'string', description: 'What this POC does, the key principle, preconditions' },
      usage: { type: 'string', description: 'Usage: complete command line example + parameters to replace' },
      content: { type: 'string', description: 'Body: script/POC source, raw request packet, nuclei template, invocation steps' },
      path: { type: 'string', description: 'You can also give the path of a file already on this machine (relative to pocs/ or absolute) and the knowledge base reads the body from it' },
      filename: { type: 'string', description: 'On-disk filename for the body, by default chosen by language (poc.py / poc.sh / poc.yaml…)' },
      verified: { type: 'boolean', description: 'Whether it has been actually tested and verified (**only fill true when verified on a real target**)' },
      verified_note: { type: 'string', description: 'Verification evidence: on which target, what output/result, whether authentication is needed' },
      engagement: { type: 'string', description: '[Source target] On which target this knowledge was discovered/verified (fill target id or organization name)' },
      asset_target: { type: 'string', description: '[Discovered asset] On which asset/target exactly was it verified, e.g. 10.1.2.3:8080 or http://oa.demo.com' },
      found_by_agent: { type: 'string', description: 'Code of the role that discovered it (recon / assess / vuln-scan / exploit / internal)' },
      tags: { type: 'string', description: 'Comma separated tags, e.g. "java,deserialization,rce"' },
      created_by: { type: 'string', description: 'Which role/agent accumulated it' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      /* engagement 这个参数名在本工具里表示"Source target"，不是"Which target it applies to"，
         所以不能走 resolveEngagement；只做名称补全，把 id 与中文名都记下来便于面板归类。 */
      const payload = Object.assign({}, args)
      if (typeof args.engagement === 'string' && args.engagement.trim() !== '') {
        const wanted = args.engagement.trim()
        const hit = store.listEngagements().find((e) => e.id === wanted || String(e.name) === wanted || String(e.name).includes(wanted))
        payload.engagement_id = hit ? hit.id : wanted
        payload.engagement_name = hit ? hit.name : wanted
      }
      const r = store.savePoc(payload)
      const stats = store.pocStats()
      return JSON.stringify({
        ok: true, created: r.created, code: r.poc.code, path: r.path,
        category: r.poc.category, engagement: r.poc.engagement_name || r.poc.engagement_id || null,
        asset_target: r.poc.asset_target || null, created_at: r.poc.created_at,
        verified: r.poc.verified === 1,
        hint: 'Added to the knowledge base (category: ' + (r.poc.category || 'other') + ', established at:' + r.poc.created_at + '），'
          + 'Agents on any later target can hit it directly with redteam_poc_search; the knowledge base holds ' + stats.total + ' entries.',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_list',
    description: 'List the POC/EXP in the knowledge base (filterable by kind/source/component/verified; no conditions means everything). Use it to inventory "which ready-made weapons we already hold" and avoid duplicate collection.',
    parameters: {
      kind: { type: 'string' }, source: { type: 'string' }, component: { type: 'string' },
      verified: { type: 'boolean' }, limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const items = store.searchPocs(args)
      const stats = store.pocStats()
      return JSON.stringify({ ok: true, stats: { total: stats.total, verified: stats.verified, by_kind: stats.byKind, by_source: stats.bySource },
        count: items.length,
        items: items.map((x) => ({ id: x.id, code: x.code, title: x.title, kind: x.kind, cve: x.cve, component: x.component,
          language: x.language, source: x.source, verified: x.verified === 1, hit_count: x.hit_count, tags: x.tags })) }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_update',
    description: 'Update a knowledge base entry: add the verification conclusion (verified + verified_note), correct affected versions, add usage or body, change tags. **After it verifies on a real target, always come back and set verified to true with the evidence written down** — later agents prefer verified entries.',
    parameters: {
      id: { type: 'number', description: 'Knowledge base entry id' },
      code: { type: 'string', description: 'Or specify the entry with code' },
      patch: {
        type: 'object', additionalProperties: true,
        description: '{ verified, verified_note, versions, usage, description, content, tags, severity, component, cve, source, source_url, language }',
      },
      verified: { type: 'boolean', description: 'Convenience form: pass verified directly' },
      verified_note: { type: 'string', description: 'Convenience form: pass the verification evidence directly' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const patch = Object.assign({}, args.patch || {})
      if (args.verified !== undefined) patch.verified = args.verified
      if (args.verified_note !== undefined) patch.verified_note = args.verified_note
      const row = store.updatePoc(args.id !== undefined ? args.id : args.code, patch)
      return JSON.stringify({ ok: true, id: row.id, code: row.code, verified: row.verified === 1, verified_note: row.verified_note, updated_at: row.updated_at }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_poc_use',
    description: 'Record one reuse of a knowledge base POC/EXP (on which target). Entries with many reuses rank first, so later agents prefer weapons that have seen real action.',
    parameters: {
      id: { type: 'number' },
      code: { type: 'string' },
      used_on: { type: 'string', description: 'Used where: target name / target IP / URL' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute() {
      return KB_DISABLED
      const r = store.markPocUsed(args.id !== undefined ? args.id : args.code, args.used_on)
      return JSON.stringify(r, null, 2)
    },
  })))

  /* ================================================================== 资产发现时间线 */

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_asset_timeline',
    description: 'Asset "discovery time" view: aggregates by day "how many assets were collected on which day" (internal/external separated) and lists recently discovered assets. Use it to answer "when was this asset discovered", to check recon for gaps, and to cross-check the wrap-up of this round of collection.',
    parameters: {
      engagement: { type: 'string' },
      limit: { type: 'number', description: 'Number of recent assets, default 50' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const data = store.discoveryTimeline(id, { limit: args.limit })
      return JSON.stringify({
        ok: true, engagement: id,
        span: data.span,
        days: data.days,
        recent: data.recent.map((a) => ({
          id: a.id, ip: a.ip, scope: a.scope, state: a.state, name: a.primary_name,
          discovered_at: a.discovered_at, last_seen: a.last_seen, open_ports: a.open_ports, priority: a.priority,
        })),
        hint: 'Discovery time = the moment this asset **first entered this library**; repeated collection only refreshes last_seen.'
          + 'Both the report appendix and the asset mapping page sort by it.',
      }, null, 2)
    },
  })))

  function ledgerOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('The red team asset library is unavailable')
    return new EvidenceLedger(store.db(engagementId))
  }
  function unknownsOf(engagementId) {
    if (typeof store.db !== 'function') throw new Error('The red team asset library is unavailable')
    return new UnknownRegistry(store.db(engagementId))
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_record',
    description: 'Record one piece of combat evidence. Core discipline: confidence must be filled in truthfully — claimed (subagent verbal report, must not be taken at face value) / observed (you verified it yourself) / derived (reasoned from observed) / inferred (speculation, must be labelled). ev_id is generated from a content hash and changes with a single character, so after it is stored you can check for tampering. Related skill: evidence-discipline.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true, description: 'Operation name, e.g. "nmap_scan", "webshell_established", "sql_injection_confirmed"' },
      parameters: { type: 'object', additionalProperties: true, description: 'Invocation parameters (JSON object, participates in the hash)' },
      result: { type: 'object', additionalProperties: true, required: true, description: 'Normalized result (JSON object, participates in the hash)' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred, default observed' },
      authority: { type: 'string', description: 'tool-output | database-record | screenshot | request-replay | subagent-report | operator-input, default tool-output' },
      limitations: { type: 'array', items: { type: 'string' }, description: 'Limitations, e.g. ["only scanned Top1000 ports"]' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' }, description: 'Other ev_ids that support this evidence' },
      source_agent: { type: 'string', description: 'Which subagent produced it (required for claimed)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).record({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence,
        authority: args.authority,
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        source_agent: args.source_agent,
        recorded_by: agentOf(args),
        engagement_id: id,
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_verify',
    description: 'Check whether the subagent\'s report matches the evidence ledger (hash-level check). matched=false means the subagent changed its story, exaggerated, or the item is not in the ledger.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string', required: true },
      parameters: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true, required: true },
      confidence: { type: 'string' },
      authority: { type: 'string' },
      limitations: { type: 'array', items: { type: 'string' } },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).verify({
        operation: args.operation,
        parameters: args.parameters ?? {},
        result: args.result,
        confidence: args.confidence ?? 'observed',
        authority: args.authority ?? 'tool-output',
        limitations: args.limitations ?? [],
        supporting_ev_ids: args.supporting_ev_ids ?? [],
      })
      return JSON.stringify({ ok: true, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_upgrade',
    description: 'Upgrade claimed / inferred to observed. Must carry verified_result (the output/data you verified yourself).',
    parameters: {
      engagement: { type: 'string' },
      claimed_ev_id: { type: 'string', required: true, description: 'Evidence ID to upgrade' },
      verified_result: { type: 'object', additionalProperties: true, description: 'The actual result after personal verification' },
      verified_by: { type: 'string', description: 'Who verified it, default coordinator' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = ledgerOf(id).upgrade({
        claimed_ev_id: args.claimed_ev_id,
        verified_result: args.verified_result,
        verified_by: args.verified_by ?? agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_evidence_list',
    description: 'List evidence ledger entries, filterable by operation / confidence. Before reporting, confirm there are no un-upgraded claimed items.',
    parameters: {
      engagement: { type: 'string' },
      operation: { type: 'string' },
      confidence: { type: 'string', description: 'claimed | observed | derived | inferred' },
      limit: { type: 'number' },
      offset: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = ledgerOf(id).list({
        operation: args.operation,
        confidence: args.confidence,
        engagement_id: id,
        limit: args.limit ?? 50,
        offset: args.offset ?? 0,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unverified_count',
    description: 'How many claimed/inferred entries the current target still has without closed-loop verification. When this returns >0 the report must flag the unverified count.',
    parameters: { engagement: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const count = ledgerOf(id).countUnresolvedClaims(id)
      return JSON.stringify({
        ok: true, engagement: id, unverified_count: count,
        hint: count > 0 ? `There are ${count} claimed/inferred items not yet closed out and verified; do not claim "obtained" when reporting` : 'All subagent reports have been personally verified and closed out',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_record',
    description: 'Record an unresolved combat question. Same question+domain is deduplicated.',
    parameters: {
      engagement: { type: 'string' },
      question: { type: 'string', required: true },
      severity: { type: 'string', description: 'low | medium | high | critical, default medium' },
      domain: { type: 'string', description: 'e.g. internal-recon / boundary-break / lateral-movement' },
      recommended_probe: { type: 'string', description: 'Suggested verification method' },
      supporting_ev_ids: { type: 'array', items: { type: 'string' } },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).record({
        question: args.question,
        severity: args.severity ?? 'medium',
        domain: args.domain ?? 'general',
        recommended_probe: args.recommended_probe,
        supporting_ev_ids: args.supporting_ev_ids ?? [],
        engagement_id: id,
        recorded_by: agentOf(args),
      })
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_resolve',
    description: 'Mark unresolved questions as resolved / contradicted / withdrawn.',
    parameters: {
      engagement: { type: 'string' },
      unk_id: { type: 'string', required: true },
      disposition: { type: 'string', required: true, description: 'resolved | contradicted | withdrawn' },
      resolution: { type: 'string', description: 'Resolution note' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const result = unknownsOf(id).resolve(args.unk_id, args.disposition, args.resolution, agentOf(args))
      return JSON.stringify({ ok: result.ok, engagement: id, ...result }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_unknown_list',
    description: 'List unresolved combat questions; check the open items before dispatching work.',
    parameters: {
      engagement: { type: 'string' },
      status: { type: 'string', description: 'open | investigating | blocked | contradicted | resolved' },
      severity: { type: 'string' },
      limit: { type: 'number' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const id = resolveEngagement(store, exec, args.engagement)
      const items = unknownsOf(id).list({
        status: args.status ?? 'open',
        severity: args.severity,
        engagement_id: id,
        limit: args.limit ?? 50,
      })
      return JSON.stringify({ ok: true, engagement: id, items }, null, 2)
    },
  })))
}
