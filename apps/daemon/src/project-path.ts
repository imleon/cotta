export function normalizeProjectPath(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

export function projectIdFromPath(path: string): string {
  return Buffer.from(normalizeProjectPath(path), 'utf8').toString('base64url')
}

// Session ownership sticks to the current cwd while later cwds stay inside it (e.g. `cd` into a subdirectory).
export function nextOwnerCwd(current: string | null, next: string): string {
  if (current === null) return next
  const root = normalizeProjectPath(current)
  const target = normalizeProjectPath(next)
  return target === root || target.startsWith(root === '/' ? '/' : `${root}/`) ? current : next
}

export function projectTranscriptDirName(path: string): string {
  return normalizeProjectPath(path).replace(/\//g, '-')
}

export function projectPathFromId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8')
    return decoded ? normalizeProjectPath(decoded) : null
  } catch (_error) {
    return null
  }
}
