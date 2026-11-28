import { createCottaDatabase } from './database.js'
import { loadOrCreateMachineIdentity } from './machine-identity.js'
import { formatPairingCode, PairingError, type TrustedClient, TrustedClientStore } from './trusted-clients.js'

type Io = { log(message: string): void; error(message: string): void; confirm(question: string): Promise<boolean> }

function formatTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
}

function describeClient(client: TrustedClient): string {
  const state = client.revokedAtMs === null ? `approved ${formatTime(client.approvedAtMs)}` : `revoked ${formatTime(client.revokedAtMs)}`
  return `${client.clientId.slice(0, 12)}  ${client.name}  (${client.approvalMethod}, ${state})\n    ${client.fingerprint}`
}

/** `cotta identity`: prints this machine's key fingerprint, creating the identity on first use. */
export function identityCommand(io: Pick<Io, 'log'>): number {
  const identity = loadOrCreateMachineIdentity()
  io.log(`Machine fingerprint: ${identity.fingerprint}`)
  return 0
}

const CLIENTS_HELP = `Usage: cotta clients <command>

  list [-a|--all]          List trusted clients (--all includes revoked ones)
  approve <code> [-y]      Approve a pairing request shown on the new client
  revoke <client-id> [-y]  Revoke a client immediately (id or a prefix of at least 8 characters)`

/**
 * `cotta clients …`: local management of this machine's trusted clients. It works on the database directly, so it acts
 * whether or not the daemon is running, and a running daemon sees the change on its next request.
 */
export async function clientsCommand(args: string[], options: { yes: boolean; all: boolean }, io: Io): Promise<number> {
  const [subcommand, target] = args
  if (subcommand !== 'list' && subcommand !== 'approve' && subcommand !== 'revoke') {
    io.error(CLIENTS_HELP)
    return subcommand === undefined || subcommand === 'help' ? 0 : 1
  }
  const db = createCottaDatabase()
  try {
    const store = new TrustedClientStore(db)
    if (subcommand === 'list') {
      const clients = store.list({ includeRevoked: options.all })
      io.log(clients.length ? clients.map(describeClient).join('\n') : 'No trusted clients.')
      return 0
    }
    if (!target) {
      io.error(CLIENTS_HELP)
      return 1
    }
    if (subcommand === 'approve') {
      const request = store.pairing(target)
      if (!request) {
        io.error(`No pairing request with code ${target}.`)
        return 1
      }
      if (request.approvedAtMs !== null) {
        io.log(`Pairing ${formatPairingCode(request.code)} was already approved.`)
        return 0
      }
      io.log(`Client: ${request.name}\nClient fingerprint: ${request.fingerprint}\nMachine fingerprint: ${loadOrCreateMachineIdentity().fingerprint}`)
      io.log('Check that the client shows the same client fingerprint before approving.')
      if (!options.yes && !(await io.confirm('Approve this client for full access to this machine? [y/N] '))) {
        io.log('Not approved.')
        return 1
      }
      try {
        const client = store.approvePairing(target)
        io.log(`Approved ${client.name} (${client.clientId.slice(0, 12)}).`)
        return 0
      } catch (error) {
        if (!(error instanceof PairingError)) throw error
        io.error(error.code === 'pairing_expired' ? 'This pairing request has expired; start pairing again on the client.' : `Cannot approve: ${error.code}`)
        return 1
      }
    }
    const matches = store.list({ includeRevoked: true }).filter((client) => client.clientId === target || (target.length >= 8 && client.clientId.startsWith(target)))
    if (matches.length !== 1) {
      io.error(matches.length ? `Client id ${target} is ambiguous; use more characters.` : `No client matches ${target}.`)
      return 1
    }
    const [match] = matches as [TrustedClient]
    if (match.revokedAtMs !== null) {
      io.log(`${match.name} is already revoked.`)
      return 0
    }
    if (!options.yes && !(await io.confirm(`Revoke ${match.name} (${match.clientId.slice(0, 12)})? It loses access immediately. [y/N] `))) {
      io.log('Not revoked.')
      return 1
    }
    store.revoke(match.clientId)
    io.log(`Revoked ${match.name}.`)
    return 0
  } finally {
    db.close()
  }
}
