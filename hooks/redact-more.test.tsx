import { test, expect, mock } from 'claude-code/testing'

// Wider redaction of a tool call's hint. Every fake credential is built at run
// time, so no token-shaped literal sits in this file.
const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  viewport: { columns: 120, rows: 500 },
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 400, total: 1 },
    view: {},
  },
} as const

const j = (...parts: string[]) => parts.join('')
const A35 = 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'.slice(0, 35)
const GOOGLE = j('AI', 'za', A35)
const JWT = j('ey', 'JhbGciOiJIUzI1NiJ9', '.', 'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'abcdefghijklmnop')
const NPM = j('npm', '_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'.slice(0, 36))
const PYPI = j('py', 'pi-', 'AgEIcHlwaS5vcmcCJDEyMzQ1Njc4OTAx')
const SLACK = j('xa', 'pp-', '1-A0123456789-0123456789012-abcdef')
const GLPAT = j('gl', 'pat-', 'abcdefghij0123456789')
const GHU = j('gh', 'u_', 'abcdefghijklmnopqrstuvwxyz0123456789')
const GHR = j('gh', 'r_', 'abcdefghijklmnopqrstuvwxyz0123456789')
// 41 characters of lower-case base64: with a slash, and without
const RUN_SLASH = 'a1b2c3d4e5/f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u'
const RUN_PLAIN = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u'
const RUN_ALPHA = 'qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfg'

type Case = { input: Record<string, string>; secrets: string[]; hint: RegExp }
const bash = (command: string, secrets: string[], hint: RegExp): Case => ({ input: { command }, secrets, hint })

// Each case runs as its own subagent; the pane shows the tool name and the hint
// in two Text pieces: `✓ Tool` and ` hint · time`.
const LEAKS: Case[] = [
  bash('curl -u alice:s3cr3tpw https://x.io/a', ['alice', 's3cr3tpw'], /^ curl -u … https:\/\/x\.io\/a · /),
  bash('curl --user bob:hunter2pw https://x.io/a', ['bob:', 'hunter2pw'], /^ curl --user … https:\/\/x\.io\/a · /),
  bash('curl --user=bob:hunter2pw https://x.io/a', ['bob:', 'hunter2pw'], /^ curl --user=… https:\/\/x\.io\/a · /),
  bash("curl -u 'carol:hunter2pw' https://x.io/a", ['carol', 'hunter2pw'], /^ curl -u … https:\/\/x\.io\/a · /),
  bash('tool --pass hunter2pw run', ['hunter2pw'], /^ tool --pass … run · /),
  bash('gpg --passphrase swordfish1 -d f', ['swordfish1'], /^ gpg --passphrase … -d f · /),
  bash('deploy --key abcSECRETkey now', ['abcSECRETkey'], /^ deploy --key … now · /),
  bash('deploy --secret topsecretval now', ['topsecretval'], /^ deploy --secret … now · /),
  bash('curl -H "Cookie: session=abc123xyz" https://x.io', ['abc123xyz', 'session='], /^ curl -H "Cookie: …" https:\/\/x\.io · /),
  bash('curl -H "Cookie: a=q1w2e3r4; theme=dark" x', ['q1w2e3r4', 'theme=dark'], /^ curl -H "Cookie: …" x · /),
  bash('curl -H "Set-Cookie: sid=q1w2e3r4; Path=/" x', ['q1w2e3r4'], /^ curl -H "Set-Cookie: …" x · /),
  bash('curl -d "{\\"password\\":\\"hunter2pw\\"}" https://x.io', ['hunter2pw'], /^ curl -d "\{\\"password\\":…\}" /),
  bash('curl -d \'{"password":"hunter2pw"}\' https://x.io', ['hunter2pw'], /^ curl -d '\{"password":…\}' /),
  bash("curl -d '{\\\"token\\\":\\\"hunter2pw\\\"}' https://x.io", ['hunter2pw'], /^ curl -d '\{\\"token\\":…\}' /),
  bash('docker run --env=API_KEY=abc12345 img', ['abc12345'], /^ docker run --env=API_KEY=… img · /),
  bash('curl --header=x-api-key:abc12345 x.io', ['abc12345'], /^ curl --header=x-api-key:… x\.io · /),
  bash('curl -H "Authorization: Negotiate abc12345==" x', ['abc12345'], /^ curl -H "Authorization: …" x · /),
  bash('curl -H "Authorization: AWS4-HMAC abc12345" x', ['abc12345'], /^ curl -H "Authorization: …" x · /),
  bash(`echo ${GOOGLE}`, [GOOGLE.slice(0, 12), GOOGLE.slice(12)], /^ echo … · /),
  bash(`echo ${JWT}`, [JWT.slice(0, 12), 'abcdefghijklmnop'], /^ echo … · /),
  bash(`echo ${SLACK}`, [SLACK.slice(0, 10), '0123456789'], /^ echo … · /),
  bash(`echo ${GHU}`, [GHU.slice(0, 12)], /^ echo … · /),
  bash(`echo ${GHR}`, [GHR.slice(0, 12)], /^ echo … · /),
  bash(`echo ${GLPAT}`, [GLPAT.slice(0, 12)], /^ echo … · /),
  bash(`echo ${NPM}`, [NPM.slice(0, 12)], /^ echo … · /),
  bash(`echo ${PYPI}`, [PYPI.slice(0, 12)], /^ echo … · /),
  bash(`echo ${RUN_SLASH}`, [RUN_SLASH.slice(0, 20)], /^ echo … · /),
  bash(`echo ${RUN_PLAIN}`, [RUN_PLAIN.slice(0, 20)], /^ echo … · /),
  bash(`echo ${RUN_ALPHA}`, [RUN_ALPHA.slice(0, 20)], /^ echo … · /),
  // names that are sensitive as a whole segment, or in a session form
  bash('export access-key=zzzq1', ['zzzq1'], /^ export access-key=… · /),
  bash('echo api_key=zzzq2', ['zzzq2'], /^ echo api_key=… · /),
  bash('echo KEY=zzzq3', ['zzzq3'], /^ echo KEY=… · /),
  bash('echo accessKey=zzzq4', ['zzzq4'], /^ echo accessKey=… · /),
  bash('echo PASS=zzzq5', ['zzzq5'], /^ echo PASS=… · /),
  bash('echo db.pass: zzzq6', ['zzzq6'], /^ echo db\.pass: … · /),
  bash('echo session=zzzq7', ['zzzq7'], /^ echo session=… · /),
  bash('echo sessionid=zzzq8', ['zzzq8'], /^ echo sessionid=… · /),
  bash('echo session_token=zzzq9', ['zzzq9'], /^ echo session_token=… · /),
  bash('echo sig=zzzr1', ['zzzr1'], /^ echo sig=… · /),
  bash('echo Signature=zzzr2', ['zzzr2'], /^ echo Signature=… · /),
  bash('echo private=zzzr3', ['zzzr3'], /^ echo private=… · /),
  bash('echo SENTRY_DSN=zzzr4', ['zzzr4'], /^ echo SENTRY_DSN=… · /),
  bash('echo dsn=zzzr5', ['zzzr5'], /^ echo dsn=… · /),
  bash('echo cred=zzzr6', ['zzzr6'], /^ echo cred=… · /),
  bash('echo bearer=zzzr7', ['zzzr7'], /^ echo bearer=… · /),
]

// Hints that must come out exactly as they went in.
const KEPT: Case[] = [
  { input: { command: 'npm test' }, secrets: [], hint: /^ npm test · / },
  { input: { file_path: 'src/app.ts' }, secrets: [], hint: /^ src\/app\.ts · / },
  { input: { command: 'git commit -m "fix typo"' }, secrets: [], hint: /^ git commit -m "fix typo" · / },
  { input: { command: 'ls -la' }, secrets: [], hint: /^ ls -la · / },
  { input: { command: 'python3 -m pytest tests/' }, secrets: [], hint: /^ python3 -m pytest tests\/ · / },
  { input: { command: 'echo monkey=banana' }, secrets: [], hint: /^ echo monkey=banana · / },
  { input: { command: 'echo keyboard=us' }, secrets: [], hint: /^ echo keyboard=us · / },
  { input: { command: 'ls --session-name work' }, secrets: [], hint: /^ ls --session-name work · / },
  { input: { command: 'git push -u origin main' }, secrets: [], hint: /^ git push -u origin main · / },
  { input: { command: 'sort -u names.txt' }, secrets: [], hint: /^ sort -u names\.txt · / },
  { input: { command: 'echo bypass=1 compass=2' }, secrets: [], hint: /^ echo bypass=1 compass=2 · / },
  { input: { command: `cat /var/lib/${RUN_PLAIN}` }, secrets: [], hint: /^ cat \/var\/lib\/a1b2c3d4e5f6g7h8i9j0/ },
  {
    input: { command: 'cat packages/core/src/validators2/inputs/index.ts' },
    secrets: [],
    hint: /^ cat packages\/core\/src\/validators2\/i/,
  },
]

const drive = async (cases: Case[], $: any, on: any) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  const agents = cases.map((_c, i) => ({
    id: `q${String(i).padStart(3, '0')}0000aaaa`,
    description: `case ${i}`,
    type: 'Explore',
    status: 'running',
  }))
  on('agent.list', () => ({ value: agents }))

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  for (const [i, c] of cases.entries()) {
    await $.tool.call({ tool: `Case${i}`, ...c.input, tool_use_id: `u${i}`, agentId: agents[i]!.id } as never)
  }
  await clock.advance(500)

  const pane = await $.ui.mount(PANE as never)
  const texts = ((await pane.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)
  await pane.unmount()
  const everything = texts.join('\n')
  for (const [i, c] of cases.entries()) {
    // the tool name is still shown
    expect(texts.some(t => new RegExp(`✓ Case${i}\\s*$`).test(t))).toBe(true)
    // and the hint reads as expected, with no secret in the pane
    const hint = texts.find(t => c.hint.test(t))
    expect(hint, `case ${i}: ${JSON.stringify(c.input)} -> ${texts.filter(t => /^ \S.* · /.test(t)).join(' | ')}`).toBeDefined()
    for (const secret of c.secrets) {
      expect(everything.includes(secret), `case ${i} leaks ${secret}`).toBe(false)
    }
  }
}

test('credentials of curl -u, --pass, --key, cookies, JSON bodies and --flag=pairs are hidden', async ($, on) => {
  await drive(LEAKS.slice(0, 18), $, on)
})

test('well-known token shapes and long base64 runs are hidden', async ($, on) => {
  await drive(LEAKS.slice(18, 29), $, on)
})

test('sensitive names are matched as whole segments', async ($, on) => {
  await drive(LEAKS.slice(29), $, on)
})

test('ordinary hints, and look-alike names and paths, are unchanged', async ($, on) => {
  await drive(KEPT, $, on)
})
