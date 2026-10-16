import { describe, expect, it } from 'vitest'
import { classifyBashActivity } from './bash-activity'

const evidence = (searchCount = 0, readTargets: string[] = [], listTargets: string[] = [], inspectionCount = 0) => ({ searchCount, readTargets, listTargets, inspectionCount })

describe('classifyBashActivity', () => {
  it.each([
    ['rg -n "needle value" src | sort', evidence(1)],
    ["find apps -name '*.ts' | head -n 20", evidence(1)],
    ['cat a.ts; tail -n 20 b.ts', evidence(0, ['a.ts', 'b.ts'])],
    ['pwd && stat package.json', evidence(0, [], [], 2)],
    ['ls src; tree -L 2 packages', evidence(0, [], ['src', 'packages'])],
    ["jq '.name' package.json | sort", evidence(0, ['package.json'])],
    ['cat a.ts | grep needle || true', evidence(1, ['a.ts'])],
    ['rg x || pwd', evidence(1, [], [], 1)],
    ['LC_ALL=C rg needle src', evidence(1)],
    ['A=1 B=two cat package.json', evidence(0, ['package.json'])],
    ['ag needle src', evidence(1)],
    ['ack needle src', evidence(1)],
    ['less package.json', evidence(0, ['package.json'])],
    ['more README.md', evidence(0, ['README.md'])],
    ['strings app.bin', evidence(0, ['app.bin'])],
    ["jq --arg key value '.name' package.json", evidence(0, ['package.json'])],
    ["jq '.name' a.json b.json", evidence(0, ['a.json', 'b.json'])],
    ["jq --arg key value '.name' a.json b.json", evidence(0, ['a.json', 'b.json'])],
    ['cat "C:\\temp\\file"', evidence(0, ['C:\\temp\\file'])],
    ['cat -- 2026', evidence(0, ['2026'])],
    ['ls -- 2026', evidence(0, [], ['2026'])],
  ])('recognizes common context exploration: %s', (command, expected) => {
    expect(classifyBashActivity(command)).toEqual(expected)
  })

  it.each([
    'rg x > out',
    'rg x &',
    'rg x $(touch out)',
    'rg "$HOME"',
    "find . $'-delete'",
    'awk \'BEGIN { system("touch out") }\'',
    "awk '{ print $1 }' package.json",
    'A=1 B=two',
    "jq --arg key '.name' package.json",
    'find . -delete',
    'find . -fprint out',
    'rg --pre cat x',
    'sort -o out input',
    'sort -uo out input',
    'sort --out out input',
    'tree -Co out .',
    'tree --output=out .',
    'file --compile input',
    'tail -f log',
    'npm test',
    'git status',
    'rg x && npm test',
    "rg 'unterminated",
    '',
  ])('leaves clearly unsafe or unknown commands ungrouped: %s', (command) => {
    expect(classifyBashActivity(command)).toBeNull()
  })

  it('does not require exhaustive option knowledge', () => {
    expect(classifyBashActivity('rg --future-option needle src')).toEqual(evidence(1))
    expect(classifyBashActivity('ls --definitely-unknown src')).toEqual(evidence(0, [], ['src']))
  })

  it('bounds render-time command scanning', () => {
    expect(classifyBashActivity(`rg ${'x'.repeat(16 * 1024)}`)).toBeNull()
  })
})
