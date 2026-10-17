// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSidebar, chatPath, sessionLocationFromPath } from './app-layout'

afterEach(cleanup)

describe('session URL', () => {
  it('round-trips session and turn ids', () => {
    expect(sessionLocationFromPath('/')).toBeNull()
    expect(sessionLocationFromPath('/agents')).toBeNull()
    expect(sessionLocationFromPath('/s/')).toBeNull()
    expect(sessionLocationFromPath('/s/a/b/c')).toBeNull()
    expect(sessionLocationFromPath('/s/%E0')).toBeNull()
    expect(sessionLocationFromPath('/s/abc')).toEqual({ sessionId: 'abc', turnId: null })
    expect(sessionLocationFromPath('/s/abc/t-1/')).toEqual({ sessionId: 'abc', turnId: 't-1' })
    const location = { sessionId: 'a b/c', turnId: 'x?y' }
    expect(sessionLocationFromPath(chatPath(location))).toEqual(location)
    expect(chatPath(null)).toBe('/')
    expect(chatPath({ sessionId: 'abc', turnId: null })).toBe('/s/abc')
  })
})

describe('AppSidebar', () => {
  it('shows quick-nav Agents, Shares, Terminal, Stats and navigates Agents', () => {
    const onNavigate = vi.fn()
    const onOpenStats = vi.fn()
    render(
      <AppSidebar
        activeAppNav="agents"
        terminalOpen={false}
        terminalConnected={false}
        createMenu={null}
        projectsContent={null}
        onNavigate={onNavigate}
        onOpenTerminal={vi.fn()}
        onExpandSidebar={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenStats={onOpenStats}
      />,
    )

    const agents = screen.getByRole('link', { name: 'Agents' })
    const shares = screen.getByRole('link', { name: 'Shares' })
    const terminal = screen.getByRole('button', { name: 'Terminal' })
    const stats = screen.getByRole('button', { name: 'Stats' })
    expect(agents.getAttribute('href')).toBe('/agents')
    expect(shares.getAttribute('href')).toBe('/shares')
    expect(agents.nextElementSibling).toBe(shares)
    expect(shares.nextElementSibling).toBe(terminal)
    expect(terminal.nextElementSibling).toBe(stats)
    expect(agents.querySelector('svg')?.dataset.icon).toBe('RobotOutlined')
    fireEvent.click(agents)
    expect(onNavigate).toHaveBeenCalledWith('agents')
    fireEvent.click(stats)
    expect(onOpenStats).toHaveBeenCalledTimes(1)
    const brand = screen.getByRole('link', { name: 'Cotta home' })
    expect(brand.getAttribute('href')).toBe('/')
    fireEvent.click(brand)
    expect(onOpenStats).toHaveBeenCalledTimes(2)
    fireEvent.click(brand, { metaKey: true })
    expect(onOpenStats).toHaveBeenCalledTimes(2)
  })

  it('shows the logo lockup with tagline', () => {
    render(
      <AppSidebar
        activeAppNav="agents"
        terminalOpen={false}
        terminalConnected={false}
        createMenu={null}
        projectsContent={null}
        onNavigate={vi.fn()}
        onOpenTerminal={vi.fn()}
        onExpandSidebar={vi.fn()}
        onOpenAccount={vi.fn()}
        onOpenSearch={vi.fn()}
        onOpenStats={vi.fn()}
      />,
    )

    const logo = screen.getByRole('img', { name: 'Cotta' })
    const lockup = logo.closest('.app-sidebar-brand-lockup')
    expect(lockup?.querySelector('.app-sidebar-brand-tagline')?.textContent).toBe('Claude Code on Web')
    const mark = document.querySelector('.app-sidebar-brand-mark')
    expect(mark?.getAttribute('src')).toBeTruthy()
    expect(mark?.getAttribute('alt')).toBe('')
  })
})
