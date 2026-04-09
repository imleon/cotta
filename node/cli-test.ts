import { CONFIG } from './config.js'
import { runAgent, type ServerEvent } from './agent-runner.js'
import { TaskQueue } from './queue.js'

const queue = new TaskQueue(CONFIG.maxConcurrentAgents)

async function main() {
  const prompt = process.argv[2] || 'Say hello and tell me the current date.'

  console.log('Cotta CLI Test')
  console.log('========================')
  console.log(`Prompt: ${prompt}`)
  console.log(`Workspace: ${CONFIG.workspacePath}`)
  console.log('')

  const result = await queue.enqueue(() =>
    runAgent({
      prompt,
      workspacePath: CONFIG.workspacePath,
      ...(CONFIG.defaultModel ? { model: CONFIG.defaultModel } : {}),
    }, (event: ServerEvent) => {
      switch (event.type) {
        case 'session.run.state_changed':
          console.log(`[run_state] ${event.state}`)
          break
        case 'session.control.opened':
        case 'session.control.awaiting_user':
        case 'session.control.responded':
        case 'session.control.completed':
        case 'session.control.cancel_requested':
        case 'session.control.cancelled':
        case 'session.control.failed':
          console.log(`[control_tx:${event.transaction.subtype}] ${event.transaction.status} ${event.transaction.requestId}`)
          break
        case 'session.sdk.message':
          console.log(`[sdk:${event.payload.type}] seq=${event.sequence}`)
          break
      }
    })
  )

  console.log('\n========================')
  console.log(`Exit code: ${result.exitCode}`)
  console.log(`Session: ${result.sessionId || '(unknown)'}`)
  console.log(`Events: ${result.events.length}`)
  if (result.error) console.error(`Error: ${result.error}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
