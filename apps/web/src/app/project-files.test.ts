import { describe, expect, it } from 'vitest'
import { ProjectFileHttpError } from '../api'
import { binaryFileError, fileModes, jsonPreviewContent, missingFileError, projectFileLanguage, visibleExpandedPaths } from './project-files'

describe('project file language', () => {
  it('maps common project files and falls back to text', () => {
    expect(projectFileLanguage('src/main.tsx')).toBe('javascript')
    expect(projectFileLanguage('package.json')).toBe('json')
    expect(projectFileLanguage('src/styles.css')).toBe('css')
    expect(projectFileLanguage('README.md')).toBe('markdown')
    expect(projectFileLanguage('LICENSE')).toBe('text')
  })

  it('derives preview actions from content classification', () => {
    expect(fileModes('README.md', false)).toEqual(['Markdown', 'Diff', 'Source'])
    expect(fileModes('photo.png', false)).toEqual(['Image'])
    expect(fileModes('package.json', false, true)).toEqual(['Json', 'Diff', 'Source'])
    expect(fileModes('package.json', false, false)).toEqual(['Diff', 'Source'])
    expect(fileModes('unknown.dat', false)).toEqual(['Diff', 'Source'])
    expect(fileModes('unknown.dat', true)).toEqual(['Binary'])
    expect(fileModes('README.md', false, false, 'untracked')).toEqual(['Markdown', 'Source'])
    expect(fileModes('README.md', false, false, 'deleted')).toEqual([])
    expect(fileModes('README.md', false, false, 'conflicted')).toEqual(['Source'])
    expect(binaryFileError(new ProjectFileHttpError(415, 'file_not_text'))).toBe(true)
    expect(binaryFileError(new ProjectFileHttpError(404, 'file_not_found'))).toBe(false)
    expect(missingFileError(new ProjectFileHttpError(404, 'file_not_found'))).toBe(true)
  })

  it('formats JSON Preview without changing Source content', () => {
    expect(jsonPreviewContent('{"key":1}')).toBe('{\n  "key": 1\n}')
    expect(jsonPreviewContent('{invalid}')).toBeNull()
  })

  it('watches at most 16 expanded directories while the root is visible', () => {
    const expanded = new Set(Array.from({ length: 17 }, (_, index) => `src/${String(17 - index).padStart(2, '0')}`))
    expect(visibleExpandedPaths(expanded, true)).toEqual(Array.from({ length: 16 }, (_, index) => `src/${String(index + 1).padStart(2, '0')}`))
    expect(visibleExpandedPaths(expanded, false)).toEqual([])
  })
})
