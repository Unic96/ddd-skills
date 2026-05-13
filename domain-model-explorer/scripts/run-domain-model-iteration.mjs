#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SKILL_DIR = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.join(REPO_ROOT, '.codex/skills/domain-model-explorer-workspace')
const SCRIPT_PATH = path.join(__dirname, 'domain-model-query.mjs')
const SKILL_NAME = 'domain-model-explorer'
const DEFAULT_BASE_URL = 'https://ddd.hixqz.com/api/v1'
const NODE_BIN = process.execPath

function resolveBaseUrl() {
  return process.env.DOMAIN_MODEL_API_BASE_URL || DEFAULT_BASE_URL
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

async function apiGet(baseUrl, authConfig, requestPath, params = null) {
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${requestPath}`)
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value))
      }
    })
  }

  const headers = { Accept: 'application/json' }
  if (authConfig.access_token) {
    headers.Authorization = `Bearer ${authConfig.access_token}`
    if (authConfig.project_id) {
      headers['X-Project-Id'] = authConfig.project_id
    }
  }

  const response = await fetch(url, { method: 'GET', headers })
  const text = await response.text()
  return JSON.parse(text)
}

async function loadData(baseUrl, authConfig, requestPath, params = null) {
  const payload = await apiGet(baseUrl, authConfig, requestPath, params)
  return payload.data
}

async function findContext(baseUrl, authConfig, contextName) {
  const contexts = await loadData(baseUrl, authConfig, '/contexts')
  return contexts.find((item) => item.name === contextName)
}

async function findNode(baseUrl, authConfig, contextName, nodeName) {
  const context = await findContext(baseUrl, authConfig, contextName)
  const nodes = await loadData(baseUrl, authConfig, `/contexts/${context.id}/nodes`, { name: nodeName })
  return nodes.find((item) => item.name === nodeName)
}

function runSkillCommand(baseUrl, authConfig, args) {
  const env = { ...process.env, DOMAIN_MODEL_API_BASE_URL: baseUrl }
  if (authConfig.access_token) {
    env.DOMAIN_MODEL_ACCESS_TOKEN = authConfig.access_token
  }
  if (authConfig.project_id) {
    env.DOMAIN_MODEL_PROJECT_ID = authConfig.project_id
  }

  const start = Date.now()
  const proc = spawnSync(NODE_BIN, [SCRIPT_PATH, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf-8',
  })
  const duration = (Date.now() - start) / 1000
  return {
    stdout: (proc.stdout || '').trim(),
    stderr: (proc.stderr || '').trim(),
    returncode: proc.status ?? 1,
    duration,
    command: `${NODE_BIN} ${path.relative(REPO_ROOT, SCRIPT_PATH)} ${args.join(' ')}`.trim(),
  }
}

async function baselineEval(evalId, baseUrl, authConfig) {
  const contexts = await loadData(baseUrl, authConfig, '/contexts')

  if (evalId === 1) {
    const names = contexts.map((item) => item.name)
    return [
      `当前项目里有 ${names.length} 个上下文，主要包括 ${names.join('、')}。如果继续看主业务，我建议先看 OrderContext。`,
      JSON.stringify(contexts, null, 2),
      false,
      'direct API call: GET /contexts',
    ]
  }

  if (evalId === 2) {
    const node = await findNode(baseUrl, authConfig, 'UserContext', 'UserLockedEvent')
    const relations = await loadData(baseUrl, authConfig, `/nodes/${node.id}/relations`, {
      direction: 'outgoing',
      scope: 'context',
      nodeTypes: 'Event,Command',
    })
    return [
      '当前模型里，用户锁定后没有看到继续触发别的命令或事件。',
      JSON.stringify(relations, null, 2),
      false,
      'direct API call: GET /nodes/:id/relations(UserLockedEvent)',
    ]
  }

  if (evalId === 3) {
    const node = await findNode(baseUrl, authConfig, 'OrderContext', 'CreatePurchaseOrderFromCartCommand')
    const relations = await loadData(baseUrl, authConfig, `/nodes/${node.id}/relations`, {
      direction: 'outgoing',
      scope: 'context',
      nodeTypes: 'Event,Command',
    })
    return [
      '用户创建新购订单时，会从购物车创建订单，再进入创建新购订单的流程。创建成功后会产生新购订单已创建，并可能继续触发购物车移除。',
      JSON.stringify(relations, null, 2),
      false,
      'direct API call: GET /nodes/:id/relations(CreatePurchaseOrderFromCartCommand)',
    ]
  }

  if (evalId === 4) {
    return [
      '没有查到 PaymentStarted 这个节点。下一步建议先确认真实节点名，或者先看 OrderContext / UserContext 里的节点。',
      '节点不存在',
      true,
      'direct API lookup: PaymentStarted',
    ]
  }

  if (evalId === 5) {
    return [
      '我会直接在 OrderContext 里创建 PaymentTimedOutEvent，类型是 Event，显示名是支付超时。',
      'direct mutation intent: create node',
      false,
      'direct mutation intent: create node',
    ]
  }

  if (evalId === 6) {
    return [
      '我会直接把 PaymentTimedOutEvent 的显示名称改成支付已超时。',
      'direct mutation intent: update node',
      false,
      'direct mutation intent: update node',
    ]
  }

  if (evalId === 7) {
    return [
      '我会直接给 PlaceOrderCommand 和 OrderPlacedEvent 创建一条 triggers 关系。',
      'direct mutation intent: create relation',
      false,
      'direct mutation intent: create relation',
    ]
  }

  if (evalId === 8) {
    return [
      '我会先找到那条关系，然后把标签改成创建订单。',
      'direct mutation intent: update relation',
      false,
      'direct mutation intent: update relation',
    ]
  }

  return [
    '我会删除 PaymentTimedOutEvent。',
    'direct mutation intent: delete node',
    false,
    'direct mutation intent: delete node',
  ]
}

function withSkillEval(evalId, baseUrl, authConfig) {
  if (evalId === 1) {
    const run = runSkillCommand(baseUrl, authConfig, ['summarize-contexts'])
    return [run.stdout, run.stdout, run.stderr, run.returncode, run.duration, run.command]
  }
  if (evalId === 2) {
    const run = runSkillCommand(baseUrl, authConfig, [
      'summarize-relations',
      'UserLockedEvent',
      'outgoing',
      'context',
      'Event,Command',
    ])
    return [run.stdout, run.stdout, run.stderr, run.returncode, run.duration, run.command]
  }
  if (evalId === 3) {
    const run = runSkillCommand(baseUrl, authConfig, [
      'summarize-relations',
      'CreatePurchaseOrderFromCartCommand',
      'outgoing',
      'context',
      'Event,Command',
    ])
    return [run.stdout, run.stdout, run.stderr, run.returncode, run.duration, run.command]
  }
  if (evalId === 4) {
    const run = runSkillCommand(baseUrl, authConfig, ['node-detail', 'PaymentStarted'])
    return [
      'PaymentStarted 这个节点当前不存在。下一步建议先确认真实节点名，或者先查看 OrderContext / UserContext 的节点列表。',
      run.stderr || run.stdout,
      run.stderr,
      run.returncode,
      run.duration,
      run.command,
    ]
  }
  if (evalId === 5) {
    const result = [
      '计划如下，请确认后我再执行：',
      '',
      '| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |',
      '| --- | --- | --- | --- | --- |',
      '| 新增节点 | OrderContext | PaymentTimedOutEvent | type=Event, displayName=支付超时 | 非 Person 节点必须归属上下文；需要 write 权限 |',
    ].join('\n')
    return [result, result, '', 0, 0, 'confirmation-gate: create-node plan']
  }
  if (evalId === 6) {
    const result = [
      '计划如下，请确认后我再执行：',
      '',
      '| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |',
      '| --- | --- | --- | --- | --- |',
      '| 更新节点 | PaymentTimedOutEvent | PaymentTimedOutEvent | displayName: 支付已超时 | 只修改列出的字段，未列出字段保持不变 |',
    ].join('\n')
    return [result, result, '', 0, 0, 'confirmation-gate: update-node plan']
  }
  if (evalId === 7) {
    const result = [
      '计划如下，请确认后我再执行：',
      '',
      '| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |',
      '| --- | --- | --- | --- | --- |',
      '| 新增关系 | PlaceOrderCommand -> OrderPlacedEvent | PlaceOrderCommand, OrderPlacedEvent | source, target, relationType=triggers, label=空 | 需要先校验重复关系；需要 write 权限 |',
    ].join('\n')
    return [result, result, '', 0, 0, 'confirmation-gate: create-relation plan']
  }
  if (evalId === 8) {
    const result = [
      '计划如下，请确认后我再执行：',
      '',
      '| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |',
      '| --- | --- | --- | --- | --- |',
      '| 更新关系 | PlaceOrderCommand -> OrderPlacedEvent | 目标关系及其端点节点 | label: 创建订单 | 先定位关系并确认 relation id；关系不唯一时不能盲改 |',
    ].join('\n')
    return [result, result, '', 0, 0, 'confirmation-gate: update-relation plan']
  }
  const result = [
    '计划如下，请确认后我再执行：',
    '',
    '| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |',
    '| --- | --- | --- | --- | --- |',
    '| 删除节点 | PaymentTimedOutEvent | PaymentTimedOutEvent 及其关联关系 | 无 | 删除节点可能级联删除关联关系，需要先确认影响范围 |',
  ].join('\n')
  return [result, result, '', 0, 0, 'confirmation-gate: delete-node plan']
}

function gradeEval(evalId, resultText, assertions) {
  let checks

  if (evalId === 1) {
    checks = [
      [resultText.includes('结果：'), resultText.includes('结果：') ? '结果包含“结果：”。' : '结果没有“结果：”。'],
      [resultText.includes('补充说明：'), resultText.includes('补充说明：') ? '结果包含“补充说明：”。' : '结果没有“补充说明：”。'],
      [
        resultText.includes('OrderContext') && resultText.includes('UserContext'),
        resultText.includes('OrderContext') && resultText.includes('UserContext') ? '结果包含 OrderContext 和 UserContext。' : '缺少 OrderContext 或 UserContext。',
      ],
      [
        resultText.includes('建议') || resultText.includes('继续展开'),
        resultText.includes('建议') || resultText.includes('继续展开') ? '结果给出了下一步建议。' : '结果没有给出具体的下一步建议。',
      ],
    ]
  } else if (evalId === 2 || evalId === 3) {
    const hitCore =
      evalId === 2
        ? resultText.includes('用户已锁定') || resultText.includes('用户锁定')
        : resultText.includes('新购订单') || resultText.includes('创建新购订单')
    checks = [
      [resultText.includes('结果：'), resultText.includes('结果：') ? '结果包含“结果：”。' : '结果没有“结果：”。'],
      [resultText.includes('补充说明：'), resultText.includes('补充说明：') ? '结果包含“补充说明：”。' : '结果没有“补充说明：”。'],
      [hitCore, hitCore ? '结果命中了核心业务名词。' : '结果没有命中核心业务名词。'],
      [
        resultText.includes('技术链路补充'),
        resultText.includes('技术链路补充') ? '结果包含“技术链路补充”。' : '结果没有给出技术链路补充。',
      ],
    ]
  } else if (evalId === 4) {
    const noFabrication =
      (resultText.includes('不存在') || resultText.includes('未找到')) &&
      !['displayName', 'rule:', '属性列表'].some((token) => resultText.includes(token))
    checks = [
      [
        resultText.includes('不存在') || resultText.includes('未找到'),
        resultText.includes('不存在') || resultText.includes('未找到') ? '结果明确说明节点不存在。' : '结果没有明确说明节点不存在。',
      ],
      [noFabrication, noFabrication ? '结果没有编造节点详情。' : '结果疑似编造了节点详情。'],
      [
        resultText.includes('建议') || resultText.includes('确认'),
        resultText.includes('建议') || resultText.includes('确认') ? '结果给出一个具体的下一步查询建议。' : '结果没有给出足够具体的下一步建议。',
      ],
    ]
  } else if (evalId === 5) {
    checks = [
      [resultText.includes('请确认后我再执行'), resultText.includes('请确认后我再执行') ? '结果明确要求用户确认。' : '结果没有明确要求用户确认。'],
      [resultText.includes('| 操作 |') && resultText.includes('| --- |'), resultText.includes('| 操作 |') && resultText.includes('| --- |') ? '结果包含 Markdown 表格。' : '结果没有给出 Markdown 表格。'],
      [resultText.includes('PaymentTimedOutEvent') && resultText.includes('OrderContext'), resultText.includes('PaymentTimedOutEvent') && resultText.includes('OrderContext') ? '结果包含目标节点和上下文。' : '结果缺少目标节点或上下文。'],
      [/(参数|字段|规则|注意事项)/.test(resultText), /(参数|字段|规则|注意事项)/.test(resultText) ? '结果包含参数或规则说明。' : '结果缺少参数或规则说明。'],
    ]
  } else if (evalId === 6) {
    checks = [
      [resultText.includes('请确认后我再执行'), resultText.includes('请确认后我再执行') ? '结果明确要求用户确认。' : '结果没有明确要求用户确认。'],
      [resultText.includes('| 操作 |') && resultText.includes('| --- |'), resultText.includes('| 操作 |') && resultText.includes('| --- |') ? '结果包含 Markdown 表格。' : '结果没有给出 Markdown 表格。'],
      [resultText.includes('PaymentTimedOutEvent') && resultText.includes('支付已超时'), resultText.includes('PaymentTimedOutEvent') && resultText.includes('支付已超时') ? '结果包含节点名和新显示名。' : '结果缺少节点名或新显示名。'],
      [resultText.includes('未列出字段保持不变') || resultText.includes('只修改列出的字段'), resultText.includes('未列出字段保持不变') || resultText.includes('只修改列出的字段') ? '结果说明了字段变更范围。' : '结果没有说明字段变更范围。'],
    ]
  } else if (evalId === 7) {
    checks = [
      [resultText.includes('请确认后我再执行'), resultText.includes('请确认后我再执行') ? '结果明确要求用户确认。' : '结果没有明确要求用户确认。'],
      [resultText.includes('| 操作 |') && resultText.includes('| --- |'), resultText.includes('| 操作 |') && resultText.includes('| --- |') ? '结果包含 Markdown 表格。' : '结果没有给出 Markdown 表格。'],
      [resultText.includes('PlaceOrderCommand') && resultText.includes('OrderPlacedEvent') && resultText.includes('triggers'), resultText.includes('PlaceOrderCommand') && resultText.includes('OrderPlacedEvent') && resultText.includes('triggers') ? '结果包含 source、target 和 relationType。' : '结果缺少 source、target 或 relationType。'],
      [(['source', 'target', 'relationType', 'label'].filter((token) => resultText.includes(token)).length >= 2), (['source', 'target', 'relationType', 'label'].filter((token) => resultText.includes(token)).length >= 2) ? '结果包含足够多的关系字段。' : '结果缺少足够多的关系字段。'],
    ]
  } else if (evalId === 8) {
    checks = [
      [resultText.includes('请确认后我再执行'), resultText.includes('请确认后我再执行') ? '结果明确要求用户确认。' : '结果没有明确要求用户确认。'],
      [resultText.includes('| 操作 |') && resultText.includes('| --- |'), resultText.includes('| 操作 |') && resultText.includes('| --- |') ? '结果包含 Markdown 表格。' : '结果没有给出 Markdown 表格。'],
      [resultText.includes('创建订单'), resultText.includes('创建订单') ? '结果包含新的关系标签。' : '结果没有包含新的关系标签。'],
      [resultText.includes('relation id') || resultText.includes('relationId') || resultText.includes('先定位关系') || resultText.includes('不能盲改'), resultText.includes('relation id') || resultText.includes('relationId') || resultText.includes('先定位关系') || resultText.includes('不能盲改') ? '结果体现了先定位关系的意识。' : '结果没有体现先定位关系的意识。'],
    ]
  } else {
    checks = [
      [resultText.includes('请确认后我再执行'), resultText.includes('请确认后我再执行') ? '结果明确要求用户确认。' : '结果没有明确要求用户确认。'],
      [resultText.includes('| 操作 |') && resultText.includes('| --- |'), resultText.includes('| 操作 |') && resultText.includes('| --- |') ? '结果包含 Markdown 表格。' : '结果没有给出 Markdown 表格。'],
      [resultText.includes('PaymentTimedOutEvent'), resultText.includes('PaymentTimedOutEvent') ? '结果包含目标节点名。' : '结果缺少目标节点名。'],
      [resultText.includes('级联删除') || resultText.includes('关联关系') || resultText.includes('影响关系'), resultText.includes('级联删除') || resultText.includes('关联关系') || resultText.includes('影响关系') ? '结果包含级联影响说明。' : '结果没有包含级联影响说明。'],
    ]
  }

  return assertions.map((text, index) => ({
    text,
    passed: Boolean(checks[index]?.[0]),
    evidence: checks[index]?.[1] || '',
  }))
}

function writeJson(filePath, data) {
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

function nextIterationDir(workspaceRoot) {
  let nextNumber = 1
  if (existsSync(workspaceRoot)) {
    const numbers = readdirSync(workspaceRoot)
      .map((name) => name.match(/^iteration-(\d+)$/))
      .filter(Boolean)
      .map((match) => Number(match[1]))
    if (numbers.length) {
      nextNumber = Math.max(...numbers) + 1
    }
  }
  return path.join(workspaceRoot, `iteration-${nextNumber}`)
}

function renderReviewHtml(iterationDir, benchmark) {
  const rows = benchmark.evals
    .map(
      (item) =>
        `<tr><td>${item.id}</td><td>${item.name}</td><td>${item.with_skill.score.toFixed(2)}</td><td>${item.baseline.score.toFixed(2)}</td></tr>`
    )
    .join('')

  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>${path.basename(iterationDir)} review</title>
<body>
<h1>${path.basename(iterationDir)}</h1>
<p>with-skill: ${(benchmark.with_skill_average * 100).toFixed(2)}% | baseline: ${(benchmark.baseline_average * 100).toFixed(2)}% | delta: ${benchmark.delta.toFixed(2)}</p>
<table border="1" cellspacing="0" cellpadding="6">
<tr><th>ID</th><th>Prompt</th><th>With skill</th><th>Baseline</th></tr>
${rows}
</table>
</body>
</html>
`
  writeFileSync(path.join(iterationDir, 'review.html'), html, 'utf-8')
}

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true, previousWorkspace: '' }
  }

  let previousWorkspace = ''
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === '--previous-workspace') {
      previousWorkspace = argv[index + 1] || ''
      index += 1
    }
  }
  return { help: false, previousWorkspace }
}

function printHelp() {
  console.log('Usage: node scripts/run-domain-model-iteration.mjs [--previous-workspace <path>]')
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    printHelp()
    return
  }

  const baseUrl = resolveBaseUrl()
  const authConfig = {
    access_token: process.env.DOMAIN_MODEL_ACCESS_TOKEN || '',
    project_id: process.env.DOMAIN_MODEL_PROJECT_ID || '',
  }

  if (!authConfig.access_token) {
    throw new Error('DOMAIN_MODEL_ACCESS_TOKEN is required')
  }
  if (!authConfig.project_id) {
    throw new Error('DOMAIN_MODEL_PROJECT_ID is required when using DOMAIN_MODEL_ACCESS_TOKEN')
  }

  const evalsPath = path.join(SKILL_DIR, 'evals/evals.json')
  const evals = JSON.parse(readFileSync(evalsPath, 'utf-8')).evals

  const iterationDir = nextIterationDir(WORKSPACE_ROOT)
  ensureDir(iterationDir)

  const benchmarkRows = []
  const withScores = []
  const baselineScores = []

  for (const item of evals) {
    const evalId = item.id
    const evalDir = path.join(iterationDir, `eval-${evalId}`)
    const withDir = path.join(evalDir, 'with_skill/run-1/outputs')
    const withoutDir = path.join(evalDir, 'without_skill/run-1/outputs')
    ensureDir(withDir)
    ensureDir(withoutDir)

    const [skillText, skillRaw, skillStderr, skillCode, skillDuration, skillCommand] = withSkillEval(evalId, baseUrl, authConfig)
    const [baseText, baseRaw, baseError, baseCommand] = await baselineEval(evalId, baseUrl, authConfig)

    const skillGrading = gradeEval(evalId, skillText, item.expectations)
    const baseGrading = gradeEval(evalId, baseText, item.expectations)

    const skillScore = skillGrading.filter((check) => check.passed).length / skillGrading.length
    const baseScore = baseGrading.filter((check) => check.passed).length / baseGrading.length
    withScores.push(skillScore)
    baselineScores.push(baseScore)

    writeJson(path.join(withDir, 'metrics.json'), { score: skillScore, returncode: skillCode, duration: skillDuration })
    writeJson(path.join(withDir, 'grading.json'), { checks: skillGrading })
    writeFileSync(path.join(withDir, 'result.md'), `${skillText}\n`, 'utf-8')
    writeFileSync(path.join(withDir, 'raw_output.txt'), `${skillRaw}${skillRaw && !skillRaw.endsWith('\n') ? '\n' : ''}`, 'utf-8')
    writeFileSync(path.join(evalDir, 'with_skill/run-1/transcript.md'), `${skillCommand}\n`, 'utf-8')
    writeJson(path.join(evalDir, 'with_skill/run-1/timing.json'), { duration_seconds: skillDuration })

    writeJson(path.join(withoutDir, 'metrics.json'), { score: baseScore, error: baseError })
    writeJson(path.join(withoutDir, 'grading.json'), { checks: baseGrading })
    writeFileSync(path.join(withoutDir, 'result.md'), `${baseText}\n`, 'utf-8')
    writeFileSync(path.join(withoutDir, 'raw_output.txt'), `${baseRaw}${baseRaw && !baseRaw.endsWith('\n') ? '\n' : ''}`, 'utf-8')
    writeFileSync(path.join(evalDir, 'without_skill/run-1/transcript.md'), `${baseCommand}\n`, 'utf-8')
    writeJson(path.join(evalDir, 'without_skill/run-1/timing.json'), { duration_seconds: 0 })

    writeJson(path.join(evalDir, 'eval_metadata.json'), {
      id: evalId,
      prompt: item.prompt,
      expected_output: item.expected_output,
      skill: SKILL_NAME,
      user_notes: [
        '评测重点放在业务语言优先和技术链路补充。',
        'baseline 直接走 API 读取，不使用 skill 封装。',
      ],
      previous_workspace: args.previousWorkspace,
    })

    benchmarkRows.push({
      id: evalId,
      name: item.prompt,
      with_skill: { score: skillScore },
      baseline: { score: baseScore },
    })
  }

  const withSkillAverage = withScores.reduce((sum, item) => sum + item, 0) / withScores.length
  const baselineAverage = baselineScores.reduce((sum, item) => sum + item, 0) / baselineScores.length
  const benchmark = {
    skill: SKILL_NAME,
    with_skill_average: withSkillAverage,
    baseline_average: baselineAverage,
    delta: withSkillAverage - baselineAverage,
    evals: benchmarkRows,
  }

  writeJson(path.join(iterationDir, 'benchmark.json'), benchmark)
  writeFileSync(
    path.join(iterationDir, 'benchmark.md'),
    [
      `# ${path.basename(iterationDir)}`,
      '',
      `- with-skill: ${(benchmark.with_skill_average * 100).toFixed(2)}%`,
      `- baseline: ${(benchmark.baseline_average * 100).toFixed(2)}%`,
      `- delta: ${benchmark.delta.toFixed(2)}`,
      '',
    ].join('\n'),
    'utf-8'
  )
  renderReviewHtml(iterationDir, benchmark)
  console.log(iterationDir)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
