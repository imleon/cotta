import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type RemotePlatform = 'feishu' | 'lark'

export type RemoteBot = {
  botId: string
  platform: RemotePlatform
  appId: string
  appSecret: string
  allProjects: boolean
  projectIds: string[]
  enabled: boolean
  configVersion: number
  pairedOpenId: string | null
  pairedChatId: string | null
  selectedProjectId: string | null
  selectedSessionId: string | null
  pairedUserName: string | null
  pairedUserAvatarUrl: string | null
  createdAtMs: number
  updatedAtMs: number
}

export type CreateRemoteBotInput = Pick<RemoteBot, 'platform' | 'appId' | 'appSecret' | 'allProjects' | 'projectIds'> & { botId?: string; enabled?: boolean }
export type UpdateRemoteBotInput = Partial<Pick<RemoteBot, 'platform' | 'appId' | 'appSecret' | 'allProjects' | 'projectIds' | 'enabled'>>

const botColumns = `bot_id, platform, app_id, app_secret, all_projects, enabled, config_version,
  paired_open_id, paired_chat_id, selected_project_id, selected_session_id, paired_user_name, paired_user_avatar_url, created_at_ms, updated_at_ms`

type BotRow = {
  bot_id: string
  platform: RemotePlatform
  app_id: string
  app_secret: string
  all_projects: number
  enabled: number
  config_version: number
  paired_open_id: string | null
  paired_chat_id: string | null
  selected_project_id: string | null
  selected_session_id: string | null
  paired_user_name: string | null
  paired_user_avatar_url: string | null
  created_at_ms: number
  updated_at_ms: number
}

function validateScope(allProjects: boolean, projectIds: string[]): void {
  if ((allProjects ? projectIds.length !== 0 : projectIds.length === 0) || new Set(projectIds).size !== projectIds.length) throw new Error('invalid remote bot project scope')
}

export class RemoteBotStore {
  constructor(private readonly db: DatabaseSync) {}

  private bot(row: BotRow): RemoteBot {
    const projectIds = this.db.prepare('SELECT project_id FROM remote_bot_projects WHERE bot_id = ? ORDER BY project_id').all(row.bot_id) as Array<{ project_id: string }>
    return {
      botId: row.bot_id,
      platform: row.platform,
      appId: row.app_id,
      appSecret: row.app_secret,
      allProjects: row.all_projects === 1,
      projectIds: projectIds.map(({ project_id }) => project_id),
      enabled: row.enabled === 1,
      configVersion: row.config_version,
      pairedOpenId: row.paired_open_id,
      pairedChatId: row.paired_chat_id,
      selectedProjectId: row.selected_project_id,
      selectedSessionId: row.selected_session_id,
      pairedUserName: row.paired_user_name,
      pairedUserAvatarUrl: row.paired_user_avatar_url,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }
  }

  listBots(): RemoteBot[] {
    return (this.db.prepare(`SELECT ${botColumns} FROM remote_bots ORDER BY created_at_ms, bot_id`).all() as BotRow[]).map((row) => this.bot(row))
  }

  getBot(botId: string): RemoteBot | null {
    const row = this.db.prepare(`SELECT ${botColumns} FROM remote_bots WHERE bot_id = ?`).get(botId) as BotRow | undefined
    return row ? this.bot(row) : null
  }

  getByApp(platform: RemotePlatform, appId: string): RemoteBot | null {
    const row = this.db.prepare(`SELECT ${botColumns} FROM remote_bots WHERE platform = ? AND app_id = ?`).get(platform, appId) as BotRow | undefined
    return row ? this.bot(row) : null
  }

  create(input: CreateRemoteBotInput, now = Date.now()): RemoteBot {
    const botId = input.botId ?? randomUUID()
    validateScope(input.allProjects, input.projectIds)
    const projectIds = [...input.projectIds].sort()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(`INSERT INTO remote_bots
          (bot_id, platform, app_id, app_secret, all_projects, enabled, config_version, created_at_ms, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(botId, input.platform, input.appId, input.appSecret, input.allProjects ? 1 : 0, input.enabled === false ? 0 : 1, now, now)
      const insertProject = this.db.prepare('INSERT INTO remote_bot_projects (bot_id, project_id) VALUES (?, ?)')
      for (const projectId of projectIds) insertProject.run(botId, projectId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return this.getBot(botId) as RemoteBot
  }

  update(botId: string, update: UpdateRemoteBotInput, now = Date.now()): RemoteBot | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getBot(botId)
      if (!current) {
        this.db.exec('COMMIT')
        return null
      }
      const next = {
        platform: update.platform ?? current.platform,
        appId: update.appId ?? current.appId,
        appSecret: update.appSecret || current.appSecret,
        allProjects: update.allProjects ?? current.allProjects,
        projectIds: update.projectIds ? [...update.projectIds].sort() : current.projectIds,
        enabled: update.enabled ?? current.enabled,
      }
      validateScope(next.allProjects, next.projectIds)
      const scopeChanged = next.allProjects !== current.allProjects || next.projectIds.length !== current.projectIds.length || next.projectIds.some((id, index) => id !== current.projectIds[index])
      if (next.platform === current.platform && next.appId === current.appId && next.appSecret === current.appSecret && !scopeChanged && next.enabled === current.enabled) {
        this.db.exec('COMMIT')
        return current
      }
      const appChanged = next.platform !== current.platform || next.appId !== current.appId
      const clearSelection = appChanged || (!next.allProjects && current.selectedProjectId !== null && !next.projectIds.includes(current.selectedProjectId))
      this.db
        .prepare(`UPDATE remote_bots SET platform = ?, app_id = ?, app_secret = ?, all_projects = ?, enabled = ?,
          paired_open_id = CASE WHEN ? THEN NULL ELSE paired_open_id END,
          paired_chat_id = CASE WHEN ? THEN NULL ELSE paired_chat_id END,
          paired_user_name = CASE WHEN ? THEN NULL ELSE paired_user_name END,
          paired_user_avatar_url = CASE WHEN ? THEN NULL ELSE paired_user_avatar_url END,
          selected_project_id = CASE WHEN ? THEN NULL ELSE selected_project_id END,
          selected_session_id = CASE WHEN ? THEN NULL ELSE selected_session_id END,
          config_version = config_version + 1, updated_at_ms = ? WHERE bot_id = ?`)
        .run(
          next.platform,
          next.appId,
          next.appSecret,
          next.allProjects ? 1 : 0,
          next.enabled ? 1 : 0,
          appChanged ? 1 : 0,
          appChanged ? 1 : 0,
          appChanged ? 1 : 0,
          appChanged ? 1 : 0,
          clearSelection ? 1 : 0,
          clearSelection ? 1 : 0,
          now,
          botId,
        )
      if (scopeChanged) {
        this.db.prepare('DELETE FROM remote_bot_projects WHERE bot_id = ?').run(botId)
        const insertProject = this.db.prepare('INSERT INTO remote_bot_projects (bot_id, project_id) VALUES (?, ?)')
        for (const projectId of next.projectIds) insertProject.run(botId, projectId)
      }
      this.db.exec('COMMIT')
      return this.getBot(botId)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  setSelection(botId: string, selectedProjectId: string | null, selectedSessionId: string | null, now = Date.now()): RemoteBot | null {
    if (selectedSessionId && !selectedProjectId) throw new Error('selected session requires a project')
    const updated = this.db.prepare('UPDATE remote_bots SET selected_project_id = ?, selected_session_id = ?, updated_at_ms = ? WHERE bot_id = ?').run(selectedProjectId, selectedSessionId, now, botId)
    return updated.changes === 1 ? this.getBot(botId) : null
  }

  delete(botId: string): boolean {
    return this.db.prepare('DELETE FROM remote_bots WHERE bot_id = ?').run(botId).changes === 1
  }

  setEnabled(botId: string, enabled: boolean, now = Date.now()): boolean {
    return this.db.prepare('UPDATE remote_bots SET enabled = ?, config_version = config_version + 1, updated_at_ms = ? WHERE bot_id = ?').run(enabled ? 1 : 0, now, botId).changes === 1
  }

  bind(botId: string, openId: string, chatId: string, userName: string | null, avatarUrl: string | null, now = Date.now()): RemoteBot | null {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db
        .prepare(`UPDATE remote_bots SET paired_open_id = ?, paired_chat_id = ?, paired_user_name = ?, paired_user_avatar_url = ?,
          selected_project_id = NULL, selected_session_id = NULL,
          updated_at_ms = ?
          WHERE bot_id = ? AND enabled = 1
          RETURNING ${botColumns}`)
        .get(openId, chatId, userName, avatarUrl, now, botId) as BotRow | undefined
      this.db.exec('COMMIT')
      return row ? this.bot(row) : null
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  unpair(botId: string, now = Date.now()): boolean {
    return (
      this.db
        .prepare(`UPDATE remote_bots SET paired_open_id = NULL, paired_chat_id = NULL,
          selected_project_id = NULL, selected_session_id = NULL,
          paired_user_name = NULL, paired_user_avatar_url = NULL,
          config_version = config_version + 1, updated_at_ms = ? WHERE bot_id = ?`)
        .run(now, botId).changes === 1
    )
  }
}
