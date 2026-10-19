import type { AuthSessionResponse } from '@cotta/shared'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode, PointerEvent as ReactPointerEvent, RefObject } from 'react'
import faviconUrl from '../assets/favicon.svg'
import logoUrl from '../assets/logo.svg'
import { ProjectFolderIcon } from './session-history'

export const APP_NAV_ITEMS = [
  { key: 'chat', label: 'Chat', path: '/' },
  { key: 'agents', label: 'Agents', path: '/agents' },
  { key: 'automations', label: 'Automations', path: '/automations' },
  { key: 'skills', label: 'Skills', path: '/skills' },
  { key: 'mcp', label: 'MCP', path: '/mcp' },
  { key: 'shares', label: 'Shares', path: '/shares' },
  { key: 'settings', label: 'Settings', path: '/settings' },
] as const

const APP_QUICK_NAV_ITEMS = APP_NAV_ITEMS.filter((item) => item.key === 'agents' || item.key === 'shares')

export type AppNavKey = (typeof APP_NAV_ITEMS)[number]['key']

export function appNavPath(key: AppNavKey): string {
  return APP_NAV_ITEMS.find((item) => item.key === key)?.path ?? '/'
}

export function appNavKeyFromPath(): AppNavKey {
  if (sessionLocationFromPath()) return 'chat'
  const pathKey = APP_NAV_ITEMS.find((item) => item.path === window.location.pathname)?.key
  if (pathKey) return pathKey
  const hashKey = window.location.pathname === '/' ? window.location.hash.slice(1) : ''
  return APP_NAV_ITEMS.some((item) => item.key === hashKey) ? (hashKey as AppNavKey) : 'chat'
}

export type SessionLocation = { sessionId: string; turnId: string | null }

export function sessionLocationFromPath(pathname = window.location.pathname): SessionLocation | null {
  const match = /^\/s\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (!match) return null
  try {
    return { sessionId: decodeURIComponent(match[1]!), turnId: match[2] ? decodeURIComponent(match[2]) : null }
  } catch {
    return null
  }
}

export function chatPath(location: SessionLocation | null): string {
  if (!location) return '/'
  return `/s/${encodeURIComponent(location.sessionId)}${location.turnId ? `/${encodeURIComponent(location.turnId)}` : ''}`
}

export function terminalOpenFromLocation(): boolean {
  return (window.location.pathname === '/' || sessionLocationFromPath() !== null) && new URLSearchParams(window.location.search).get('terminal') === '1'
}

function AppNavIcon({ itemKey }: { itemKey: AppNavKey | 'terminal' }) {
  if (itemKey === 'agents') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="RobotOutlined">
        <path
          d="M9 3h6v2h-2v2h4a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-8a3 3 0 0 1 3-3h4V5H9V3Zm-2 6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1H7Zm2 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"
          fill="currentColor"
        />
      </svg>
    )
  }
  if (itemKey === 'chat') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4.5 5.5h11a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-3.5 3v-3H4.5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z" />
      </svg>
    )
  }
  if (itemKey === 'automations') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="ExternalOutlined">
        <path
          d="M5.5 13a4 4 0 0 1 3.57 5.804c.88.445 1.876.696 2.93.696 1.053 0 2.049-.25 2.929-.696A4.001 4.001 0 0 1 18.499 13a6.494 6.494 0 0 0-3.034-5.5 4 4 0 0 1-6.93 0A6.495 6.495 0 0 0 5.5 13Zm-1.984.526A8.499 8.499 0 0 1 8 5.498a4 4 0 0 1 8 0 8.499 8.499 0 0 1 4.484 8.028 4 4 0 1 1-4.19 6.811A8.46 8.46 0 0 1 12 21.5a8.456 8.456 0 0 1-4.294-1.163 4 4 0 0 1-4.19-6.811ZM12 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18.5 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-13 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z"
          fill="currentColor"
        />
      </svg>
    )
  }
  if (itemKey === 'skills') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="AppDefaultOutlined">
        <path
          d="M1 6.895a1 1 0 0 1 .586-.91l10-4.545a1 1 0 0 1 .828 0l10 4.545a1 1 0 0 1 .586.91v9.739a1 1 0 0 1-.553.894l-10 5a1 1 0 0 1-.894 0l-10-5A1 1 0 0 1 1 16.634V6.895Zm18.218-.166L12 3.45 4.743 6.746l7.217 3.109 7.258-3.127ZM13 11.585v8.43l8-4V8.14l-8 3.446ZM3 8.174v7.841l8 4V11.62L3 8.174Z"
          fill="currentColor"
        />
      </svg>
    )
  }
  if (itemKey === 'mcp') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="PlatformOutlined">
        <path
          d="M13.753 5.933a1.003 1.003 0 0 1 .486 1.336l-2.652 5.66a1.01 1.01 0 0 1-1.656.254 1.004 1.004 0 0 1-.17-1.102l2.652-5.658a1.01 1.01 0 0 1 1.34-.488v-.002Zm-8.505 4.511a.996.996 0 0 1-.359-.77.996.996 0 0 1 .36-.769l1.863-1.853a1.01 1.01 0 0 1 1.642.325 1 1 0 0 1-.218 1.091L7.323 9.675l1.213 1.206a1.001 1.001 0 0 1-.712 1.712 1.01 1.01 0 0 1-.712-.294l-1.864-1.854Zm11.64 1.855 1.864-1.855a.997.997 0 0 0 .359-.77.996.996 0 0 0-.359-.769l-1.864-1.853a1.01 1.01 0 0 1-1.424 0 1 1 0 0 1-.004 1.413l.004.003 1.213 1.207-1.213 1.206a.999.999 0 0 0 0 1.418 1.009 1.009 0 0 0 1.424 0Z"
          fill="currentColor"
        />
        <path d="M3 2c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h8v2H8a1 1 0 1 0 0 2h8a1 1 0 1 0 0-2h-3v-2h8c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2H3Zm0 2h18v12H3V4Z" fill="currentColor" />
      </svg>
    )
  }
  if (itemKey === 'shares') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true" data-icon="ShareOutlined" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="15" cy="4.5" r="2.2" />
        <circle cx="5" cy="10" r="2.2" />
        <circle cx="15" cy="15.5" r="2.2" />
        <path d="m7 8.9 6-3.3M7 11.1l6 3.3" />
      </svg>
    )
  }
  if (itemKey === 'terminal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="TerminalOutlined">
        <path d="M3 3h18v13H3zM9 20h6M12 16v4M7 8l3 2.5L7 13m6 0h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" data-icon="SettingOutlined">
      <path
        d="m4.328 19.734-.31-.34a10.91 10.91 0 0 1-2.386-4.146l-.135-.436L3.545 12 1.497 9.188l.135-.436a10.91 10.91 0 0 1 2.385-4.147l.311-.339 3.442.377 1.398-3.187.448-.101A10.843 10.843 0 0 1 12 1.09c.809 0 1.607.089 2.384.264l.448.1 1.398 3.188 3.442-.377.31.34a10.91 10.91 0 0 1 2.386 4.146l.135.436L20.455 12l2.048 2.812-.135.436a10.91 10.91 0 0 1-2.385 4.147l-.311.339-3.442-.377-1.398 3.187-.448.101a10.848 10.848 0 0 1-4.768 0l-.448-.1-1.398-3.188-3.442.377Zm3.485-2.21a1.488 1.488 0 0 1 1.525.881l1.12 2.554a9.05 9.05 0 0 0 3.084 0l1.12-2.554a1.488 1.488 0 0 1 1.524-.881l2.755.3c.665-.8 1.19-1.71 1.547-2.69l-1.644-2.258a1.488 1.488 0 0 1 0-1.752l1.644-2.258a9.091 9.091 0 0 0-1.547-2.69l-2.755.3a1.488 1.488 0 0 1-1.524-.881l-1.12-2.554a9.053 9.053 0 0 0-3.084 0l-1.12 2.554a1.488 1.488 0 0 1-1.525.881l-2.754-.3a9.09 9.09 0 0 0-1.548 2.69l1.645 2.258c.38.522.38 1.23 0 1.752l-1.644 2.258c.358.98.882 1.89 1.547 2.69l2.754-.3ZM12 16.545c-2.502 0-4.528-2.036-4.528-4.545 0-2.51 2.026-4.545 4.528-4.545S16.528 9.49 16.528 12 14.502 16.545 12 16.545Zm0-1.818c1.496 0 2.71-1.22 2.71-2.727A2.719 2.719 0 0 0 12 9.273 2.719 2.719 0 0 0 9.29 12 2.719 2.719 0 0 0 12 14.727Z"
        fill="currentColor"
      />
    </svg>
  )
}

export const APP_SIDEBAR_MIN_WIDTH = 46
export const APP_SIDEBAR_MAX_WIDTH = 360
export const APP_SIDEBAR_DEFAULT_WIDTH = 216
export const APP_SIDEBAR_COLLAPSE_WIDTH = 96
export const APP_LAYOUT_GAP = 12
export const APP_SIDEBAR_WIDTH_STORAGE_KEY = 'cotta:app-sidebar-width'
export const APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY = 'cotta:app-sidebar-last-expanded-width'
export const LEGACY_APP_SIDEBAR_WIDTH_STORAGE_KEY = 'cotta:dashboard-nav-width'
export const LEGACY_APP_SIDEBAR_LAST_EXPANDED_WIDTH_STORAGE_KEY = 'cotta:dashboard-nav-last-expanded-width'

export function clampAppSidebarWidth(width: number, maxWidth = APP_SIDEBAR_MAX_WIDTH): number {
  return Math.min(Math.max(APP_SIDEBAR_MIN_WIDTH, maxWidth), Math.max(APP_SIDEBAR_MIN_WIDTH, width))
}

type AppSidebarProps = {
  activeAppNav: AppNavKey
  terminalOpen: boolean
  terminalConnected: boolean
  authSession?: AuthSessionResponse
  createMenu: ReactNode
  projectsContent: ReactNode
  onNavigate: (nav: AppNavKey) => void
  onOpenTerminal: () => void
  onExpandSidebar: () => void
  onOpenAccount: () => void
  onOpenSearch: () => void
  onOpenStats: () => void
  searchTriggerRef?: RefObject<HTMLButtonElement | null>
}

export function AppSidebar({
  activeAppNav,
  terminalOpen,
  terminalConnected,
  authSession,
  createMenu,
  projectsContent,
  onNavigate,
  onOpenTerminal,
  onExpandSidebar,
  onOpenAccount,
  onOpenSearch,
  onOpenStats,
  searchTriggerRef,
}: AppSidebarProps) {
  const settingsSectionActive = activeAppNav === 'settings'
  const navigate = (event: ReactMouseEvent<HTMLAnchorElement>, nav: AppNavKey) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onNavigate(nav)
  }

  return (
    <aside className="app-sidebar" id="app-sidebar" aria-label="App navigation">
      <a
        className="app-sidebar-brand"
        href="/"
        aria-label="Cotta home"
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          event.preventDefault()
          onOpenStats()
        }}
      >
        <img className="app-sidebar-brand-mark" src={faviconUrl} alt="" />
        <span className="app-sidebar-brand-lockup">
          <img className="app-sidebar-brand-logo" src={logoUrl} alt="Cotta" />
          <span className="app-sidebar-brand-tagline">Claude Code on Web</span>
        </span>
      </a>
      <nav className="app-sidebar-links" aria-label="Workspace sections">
        <div className="app-sidebar-actions">
          <button ref={searchTriggerRef} className="app-sidebar-search" type="button" aria-label="Search" title="Search" onClick={onOpenSearch}>
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5" />
              <path d="m12.2 12.2 4.3 4.3" />
            </svg>
            <span className="app-sidebar-label">Search</span>
          </button>
          {createMenu}
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: grid nav container; <fieldset> would add UA border, padding and min-width */}
        <div className="app-sidebar-quick-nav" role="group" aria-label="Apps and Tool Panels">
          {APP_QUICK_NAV_ITEMS.map((item) => {
            const key = item.key
            return (
              <a
                key={key}
                className={`app-sidebar-quick-nav-link ${activeAppNav === key ? 'active' : ''}`}
                href={item.path}
                onClick={(event) => navigate(event, key)}
                aria-current={activeAppNav === key ? 'page' : undefined}
                aria-label={item.label}
                title={item.label}
              >
                <span className="app-nav-icon" aria-hidden="true">
                  <AppNavIcon itemKey={key} />
                </span>
                <span className="app-sidebar-quick-nav-label">{item.label}</span>
              </a>
            )
          })}
          <button
            className={`app-sidebar-quick-nav-link ${terminalOpen ? 'active' : ''}`}
            type="button"
            onClick={onOpenTerminal}
            aria-pressed={terminalOpen}
            aria-controls="terminal-panel"
            aria-label="Terminal"
            title="Terminal"
          >
            <span className="app-nav-icon" aria-hidden="true">
              <AppNavIcon itemKey="terminal" />
            </span>
            {terminalConnected ? (
              <span className="app-sidebar-terminal-badge" role="img" aria-label="1 connected terminal">
                1
              </span>
            ) : null}
            <span className="app-sidebar-quick-nav-label">Terminal</span>
          </button>
          <button className="app-sidebar-quick-nav-link" type="button" onClick={onOpenStats} aria-label="Stats" title="Stats">
            <span className="app-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" data-icon="InsertChartOutlined" aria-hidden="true">
                <path d="M3 4v15a2 2 0 0 0 2 2h17M8 12v5M14 9v8M20 5v12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="app-sidebar-quick-nav-label">Stats</span>
          </button>
        </div>
        <button className="app-sidebar-projects-collapsed-trigger" type="button" onClick={onExpandSidebar} aria-label="Expand navigation and show projects" title="Projects">
          <span className="app-nav-icon" aria-hidden="true">
            <ProjectFolderIcon open={false} />
          </span>
        </button>
        <section className="app-sidebar-projects-group" aria-label="Pinned sessions and projects">
          {projectsContent}
        </section>
      </nav>
      <nav className="app-sidebar-footer" aria-label="Settings and account">
        {authSession?.authenticated ? (
          <button className="app-sidebar-profile" type="button" onClick={onOpenAccount} aria-label="Account" title="Account">
            {authSession.user?.avatarUrl ? (
              <img src={authSession.user.avatarUrl} alt="" />
            ) : (
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="10" cy="7" r="3" />
                <path d="M4.5 17a5.5 5.5 0 0 1 11 0" />
              </svg>
            )}
            <span className="app-sidebar-profile-label">{authSession.user?.login ? `@${authSession.user.login}` : 'Profile'}</span>
          </button>
        ) : (
          <button className="app-sidebar-profile" type="button" disabled aria-label="Account" title="Account">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="7" r="3" />
              <path d="M4.5 17a5.5 5.5 0 0 1 11 0" />
            </svg>
            <span className="app-sidebar-profile-label">Profile</span>
          </button>
        )}
        <div className="app-sidebar-footer-actions">
          <a className="app-sidebar-footer-item" href="https://github.com/imleon/cotta" target="_blank" rel="noreferrer" title="Info">
            <span className="sr-only">Info</span>
            <span className="app-nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" data-icon="InfoOutlined" aria-hidden="true">
                <path
                  d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0 2C5.925 23 1 18.075 1 12S5.925 1 12 1s11 4.925 11 11-4.925 11-11 11Zm-1-7.5v-4a1 1 0 1 1 0-2h1.004c.55 0 .998.445.998.996.003 1.668-.002 3.336-.002 5.004h.5a1 1 0 1 1 0 2h-3a1 1 0 1 1 0-2h.5Zm1-7a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"
                  fill="currentColor"
                />
              </svg>
            </span>
          </a>
          <a
            className={`app-sidebar-footer-item ${settingsSectionActive ? 'active' : ''}`}
            href={appNavPath('settings')}
            onClick={(event) => navigate(event, 'settings')}
            aria-current={settingsSectionActive ? 'page' : undefined}
            title="Settings"
          >
            <span className="sr-only">Settings</span>
            <span className="app-nav-icon" aria-hidden="true">
              <AppNavIcon itemKey="settings" />
            </span>
          </a>
        </div>
      </nav>
    </aside>
  )
}

type AppLayoutProps = {
  layoutRef?: RefObject<HTMLDivElement | null>
  sidebarWidth: number
  sidebarCollapsed: boolean
  sidebarResizing: boolean
  sidebar: ReactNode
  children: ReactNode
  onSidebarResizeStart: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function AppLayout({ layoutRef, sidebarWidth, sidebarCollapsed, sidebarResizing, sidebar, children, onSidebarResizeStart }: AppLayoutProps) {
  return (
    <div
      ref={layoutRef}
      className="app-layout"
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
      data-sidebar-resizing={sidebarResizing ? 'true' : 'false'}
      style={{ '--app-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
    >
      {sidebar}
      {/* biome-ignore lint/a11y/useSemanticElements: pointer-driven resize handle; <hr> cannot carry the drag affordance */}
      <div
        className="app-sidebar-resize-handle"
        role="separator"
        aria-label="Resize app sidebar"
        aria-orientation="vertical"
        aria-valuemin={APP_SIDEBAR_MIN_WIDTH}
        aria-valuemax={APP_SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        onPointerDown={onSidebarResizeStart}
      />
      <div className="app-content">{children}</div>
    </div>
  )
}
