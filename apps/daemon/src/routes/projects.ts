import type { Hono } from 'hono'
import { registerDetailRoutes } from './detail-routes.js'
import { registerProjectListRoutes } from './project-list-routes.js'
import type { ProjectRoutesInput } from './project-routes-shared.js'
import { registerProjectSessionRoutes } from './project-session-routes.js'
import { registerProjectSettingsRoutes } from './project-settings-routes.js'
import { registerProjectTimelineRoutes } from './project-timeline-routes.js'

export type {
  ProjectRoutesLiveTurnManager,
  ProjectRoutesRawTranscriptCache,
  ProjectRoutesSessionSearchReady,
  ProjectRoutesSessionSearchStore,
  ProjectRoutesTimelineMetadataReader,
  ProjectRoutesTranscriptSyncer,
} from './project-routes-shared.js'

export function registerProjectRoutes(app: Hono, input: ProjectRoutesInput): void {
  registerProjectSettingsRoutes(app, input)
  registerProjectListRoutes(app, input)
  registerProjectSessionRoutes(app, input)
  registerProjectTimelineRoutes(app, input)
  registerDetailRoutes(app, input)
}
