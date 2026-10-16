export type BashActivityEvidence = {
  searchCount: number
  readTargets: string[]
  listTargets: string[]
  inspectionCount: number
}

type Connector = '|' | '&&' | '||' | ';' | '\n' | null
type CommandPart = { words: string[]; connector: Connector }

const maxCommandLength = 16 * 1024
const searchCommands = new Set(['rg', 'grep', 'ag', 'ack', 'find', 'locate'])
const readCommands = new Set(['cat', 'head', 'tail', 'less', 'more', 'wc', 'strings', 'jq', 'sort', 'uniq', 'cut'])
const listCommands = new Set(['ls', 'tree'])
const inspectionCommands = new Set(['pwd', 'which', 'whereis', 'readlink', 'realpath', 'stat', 'file', 'du'])
const inspectionCommandsRequiringTarget = new Set(['which', 'whereis', 'readlink', 'realpath', 'stat', 'file'])

const emptyEvidence = (): BashActivityEvidence => ({ searchCount: 0, readTargets: [], listTargets: [], inspectionCount: 0 })
const hasEvidence = (value: BashActivityEvidence) => value.searchCount > 0 || value.readTargets.length > 0 || value.listTargets.length > 0 || value.inspectionCount > 0

function parseCommandParts(command: string): CommandPart[] | null {
  const parts: CommandPart[] = []
  let words: string[] = []
  let word = ''
  let wordStarted = false
  let quote: "'" | '"' | null = null
  let connector: Connector = null

  const pushWord = () => {
    if (!wordStarted) return
    words.push(word)
    word = ''
    wordStarted = false
  }
  const pushPart = (nextConnector: Connector) => {
    pushWord()
    if (words.length === 0) return false
    parts.push({ words, connector })
    words = []
    connector = nextConnector
    return true
  }

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (char === '\0') return null

    if (quote) {
      if (char === quote) quote = null
      else if (quote === '"' && char === '\\') {
        const next = command[++index]
        if (next === undefined) return null
        if (next !== '\n') word += `"\\$\``.includes(next) ? next : `\\${next}`
      } else {
        if (quote === '"' && (char === '`' || char === '$')) return null
        word += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      wordStarted = true
      continue
    }
    if (char === '\\') {
      const next = command[++index]
      if (next === undefined) return null
      if (next !== '\n') {
        word += next
        wordStarted = true
      }
      continue
    }
    if (char === '`' || char === '$' || '(){}'.includes(char)) return null
    if (char === '<' || char === '>' || char === '#') return null
    if (char === ' ' || char === '\t' || char === '\r') {
      pushWord()
      continue
    }
    if (char === '\n') {
      if ((words.length > 0 || wordStarted) && !pushPart('\n')) return null
      continue
    }
    if (char === ';') {
      if (command[index + 1] === ';' || command[index + 1] === '&' || !pushPart(';')) return null
      continue
    }
    if (char === '&' || char === '|') {
      const doubled = command[index + 1] === char
      if ((char === '&' && !doubled) || !pushPart(doubled ? (`${char}${char}` as Connector) : '|')) return null
      if (doubled) index += 1
      continue
    }
    if (/\s/u.test(char)) return null
    word += char
    wordStarted = true
  }

  if (quote) return null
  if (words.length > 0 || wordStarted) pushPart(null)
  else if (connector === '|' || connector === '&&' || connector === '||') return null
  return parts.length > 0 ? parts : null
}

function operands(args: string[]): string[] {
  const result: string[] = []
  let options = true
  for (const arg of args) {
    if (options && arg === '--') {
      options = false
      continue
    }
    if (arg === '-' || (options && (arg.startsWith('-') || /^\+?\d+$/.test(arg)))) continue
    result.push(arg)
  }
  return result
}

function jqReadTargets(args: string[]): string[] | null {
  const operands: string[] = []
  let options = true
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (options && arg === '--') {
      options = false
      continue
    }
    if (options && arg === '--arg') {
      if (index + 2 >= args.length) return null
      index += 2
      continue
    }
    if (options && arg.startsWith('-')) continue
    operands.push(arg)
  }
  return operands.slice(1)
}

function hasDangerousOption(executable: string, args: string[]): boolean {
  if (executable === 'find') return args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)(?:$|0$)/.test(arg))
  if (executable === 'rg') return args.some((arg) => ['--pre', '--pre-glob', '--hostname-bin'].some((name) => arg === name || arg.startsWith(`${name}=`)))
  if (executable === 'sort') return args.some((arg) => /^-[^-]*o/.test(arg) || arg.startsWith('--out') || arg === '--compress-program' || arg.startsWith('--compress-program='))
  if (executable === 'tree') return args.some((arg) => /^-[^-]*o/.test(arg) || arg.startsWith('--out'))
  if (executable === 'file') return args.some((arg) => arg === '--compile' || /^-[^-]*C/.test(arg))
  if (executable === 'tail') return args.some((arg) => arg === '--retry' || arg.startsWith('--follow') || arg.startsWith('--pid') || /^-[^-]*[fF]/.test(arg))
  return false
}

function classifyPart(part: CommandPart, index: number, parts: CommandPart[]): BashActivityEvidence | null {
  const commandIndex = part.words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
  if (commandIndex < 0) return null
  const [executable, ...args] = part.words.slice(commandIndex)
  if (!executable || executable.includes('/') || hasDangerousOption(executable, args)) return null
  if (executable === 'true') return part.connector === '||' && index === parts.length - 1 && args.length === 0 ? emptyEvidence() : null
  if (searchCommands.has(executable)) return args.length > 0 ? { ...emptyEvidence(), searchCount: 1 } : null

  const targets = operands(args)
  if (readCommands.has(executable)) {
    const readTargets = executable === 'cat' || executable === 'wc' ? targets : executable === 'jq' ? jqReadTargets(args) : targets.slice(-1)
    if (!readTargets) return null
    if (executable === 'uniq' && targets.length > 1) return null
    return readTargets.length > 0 || part.connector === '|' ? { ...emptyEvidence(), readTargets } : null
  }
  if (executable === 'tr') return part.connector === '|' ? emptyEvidence() : null
  if (listCommands.has(executable)) return { ...emptyEvidence(), listTargets: targets.length > 0 ? targets.slice(-1) : ['.'] }
  if (inspectionCommands.has(executable)) {
    if (inspectionCommandsRequiringTarget.has(executable) && targets.length === 0) return null
    return { ...emptyEvidence(), inspectionCount: 1 }
  }
  return null
}

export function classifyBashActivity(command: string): BashActivityEvidence | null {
  if (!command || command.length > maxCommandLength) return null
  const parts = parseCommandParts(command)
  if (!parts) return null

  const result = emptyEvidence()
  for (const [index, part] of parts.entries()) {
    const evidence = classifyPart(part, index, parts)
    if (!evidence) return null
    result.searchCount += evidence.searchCount
    result.readTargets.push(...evidence.readTargets)
    result.listTargets.push(...evidence.listTargets)
    result.inspectionCount += evidence.inspectionCount
  }
  return hasEvidence(result) ? result : null
}
