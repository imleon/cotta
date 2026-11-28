import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localImageOpenFlags, openProjectImageFile, readInspectedLocalRasterImage, readLocalRasterImage } from './local-image-file.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('local image files', () => {
  it('rejects missing O_NOFOLLOW support', () => {
    expect(localImageOpenFlags(null)).toBeNull()
  })

  it('opens the canonical target of an input symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-local-image-'))
    roots.push(root)
    const target = join(root, 'target.png')
    const link = join(root, 'link.png')
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
    await writeFile(target, bytes)
    await symlink(target, link)

    expect(await readLocalRasterImage(link)).toEqual({ bytes, mimeType: 'image/png', size: bytes.byteLength })
  })

  it('opens and reads a project image from its original path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-project-image-'))
    roots.push(root)
    const path = join(root, 'image.jpg')
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    await writeFile(path, bytes)

    const image = await openProjectImageFile(root, path)
    expect(image).not.toHaveProperty('error')
    if ('error' in image) return
    try {
      expect(await readInspectedLocalRasterImage(image, 5 * 1024 * 1024, false)).toEqual({ bytes, mimeType: 'image/png', size: bytes.byteLength })
    } finally {
      await image.handle.close()
    }
  })

  it('rejects a project image path swapped to an external directory before open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cotta-project-image-'))
    const outside = await mkdtemp(join(tmpdir(), 'cotta-project-image-outside-'))
    roots.push(root, outside)
    const directory = join(root, 'images')
    const path = join(directory, 'image.png')
    await mkdir(directory)
    await writeFile(path, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    await writeFile(join(outside, 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 111, 117, 116, 115, 105, 100, 101]))

    expect(
      await openProjectImageFile(root, path, async () => {
        await rename(directory, join(root, 'images-before-swap'))
        await symlink(outside, directory)
      }),
    ).toEqual({ error: 'invalid_file_path' })
  })
})
