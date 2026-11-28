import { lstat, realpath } from 'node:fs/promises'
import type { ClaudeCodeApi } from './claude-code-api.js'

export type ProjectRootResult = { root: string } | { error: 'project_not_found' | 'project_files_failed' }

export async function resolveProjectRoot(claudeCodeApi: ClaudeCodeApi, projectId: string): Promise<ProjectRootResult> {
  const project = await claudeCodeApi.getProject(projectId)
  if (!project?.path) return { error: 'project_not_found' }
  try {
    const root = await realpath(project.path)
    return (await lstat(root)).isDirectory() ? { root } : { error: 'project_not_found' }
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT' ? { error: 'project_not_found' } : { error: 'project_files_failed' }
  }
}
