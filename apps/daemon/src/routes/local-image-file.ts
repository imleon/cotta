import { constants } from 'node:fs'
import { type FileHandle, open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'

export const MAX_AUTO_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_LOCAL_IMAGE_BYTES = 25 * 1024 * 1024

type ImageError = 'file_not_found' | 'file_too_large' | 'invalid_file_path' | 'project_files_failed' | 'unsupported_file_type'
type InspectedLocalRasterImage = { canonicalPath: string; dev: string; handle: FileHandle; ino: string; size: number }

export function isInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function rasterExtensionMime(path: string): string | null {
  const extension = path.split('.').pop()?.toLowerCase()
  return extension === 'png' ? 'image/png' : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'gif' ? 'image/gif' : extension === 'webp' ? 'image/webp' : null
}

function rasterMime(path: string, bytes: Buffer, requireMatchingExtension: boolean): string | null {
  const expected = rasterExtensionMime(path)
  if (!expected) return null
  const detected = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? 'image/jpeg'
      : bytes.subarray(0, 6).toString() === 'GIF87a' || bytes.subarray(0, 6).toString() === 'GIF89a'
        ? 'image/gif'
        : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
          ? 'image/webp'
          : null
  return detected && (!requireMatchingExtension || detected === expected) ? detected : null
}

function sameFile(left: Awaited<ReturnType<FileHandle['stat']>>, right: Awaited<ReturnType<FileHandle['stat']>>): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function imageError(error: unknown): { error: ImageError } {
  const code = error instanceof Error && 'code' in error ? error.code : null
  if (code === 'ELOOP') return { error: 'invalid_file_path' }
  if (code === 'ENOENT' || code === 'ENOTDIR') return { error: 'file_not_found' }
  return { error: 'project_files_failed' }
}

export function localImageOpenFlags(noFollow: unknown = constants.O_NOFOLLOW): number | null {
  return typeof noFollow === 'number' ? constants.O_RDONLY | noFollow : null
}

async function openStableImageFile(path: string, canonicalPath: string, projectRoot?: string): Promise<InspectedLocalRasterImage | { error: ImageError }> {
  const openFlags = localImageOpenFlags()
  if (openFlags === null) return { error: 'project_files_failed' }
  let handle: FileHandle | null = null
  try {
    handle = await open(path, openFlags)
    const openedInfo = await handle.stat()
    const openedPath = await realpath(path)
    const pathInfo = await stat(path)
    if (openedPath !== canonicalPath || (projectRoot && !isInside(projectRoot, openedPath)) || !sameFile(openedInfo, pathInfo)) return { error: 'invalid_file_path' }
    if (!openedInfo.isFile()) return { error: 'unsupported_file_type' }
    const inspected = { canonicalPath, dev: String(openedInfo.dev), handle, ino: String(openedInfo.ino), size: openedInfo.size }
    handle = null
    return inspected
  } catch (error) {
    return imageError(error)
  } finally {
    await handle?.close()
  }
}

export async function openProjectImageFile(projectRoot: string, path: string, beforeOpen?: () => void | Promise<void>): Promise<InspectedLocalRasterImage | { error: ImageError }> {
  if (!isInside(projectRoot, path)) return { error: 'invalid_file_path' }
  await beforeOpen?.()
  return openStableImageFile(path, path, projectRoot)
}

export async function inspectLocalRasterImage(path: string): Promise<InspectedLocalRasterImage | { error: ImageError }> {
  if (!rasterExtensionMime(path)) return { error: 'unsupported_file_type' }
  try {
    const canonicalPath = await realpath(path)
    return openStableImageFile(canonicalPath, canonicalPath)
  } catch (error) {
    return imageError(error)
  }
}

export async function readInspectedLocalRasterImage(
  image: InspectedLocalRasterImage,
  maxBytes = MAX_LOCAL_IMAGE_BYTES,
  requireMatchingExtension = true,
): Promise<{ bytes: Buffer; mimeType: string; size: number } | { error: ImageError }> {
  try {
    const openedInfo = await image.handle.stat()
    const openedPath = await realpath(image.canonicalPath)
    const pathInfo = await stat(image.canonicalPath)
    if (openedPath !== image.canonicalPath || !sameFile(openedInfo, pathInfo) || openedInfo.size !== image.size || pathInfo.size !== image.size) return { error: 'invalid_file_path' }
    if (image.size > maxBytes) return { error: 'file_too_large' }
    const bytes = Buffer.alloc(image.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await image.handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) return { error: 'invalid_file_path' }
      offset += bytesRead
    }
    const afterReadInfo = await image.handle.stat()
    const afterReadPath = await realpath(image.canonicalPath)
    const afterReadPathInfo = await stat(image.canonicalPath)
    if (afterReadPath !== image.canonicalPath || !sameFile(afterReadInfo, afterReadPathInfo) || afterReadInfo.size !== image.size || afterReadPathInfo.size !== image.size)
      return { error: 'invalid_file_path' }
    const mimeType = rasterMime(image.canonicalPath, bytes, requireMatchingExtension)
    return mimeType ? { bytes, mimeType, size: bytes.byteLength } : { error: 'unsupported_file_type' }
  } catch (error) {
    return imageError(error)
  }
}

export async function readLocalRasterImage(
  path: string,
  maxBytes = MAX_LOCAL_IMAGE_BYTES,
  requireMatchingExtension = true,
): Promise<{ bytes: Buffer; mimeType: string; size: number } | { error: ImageError }> {
  const image = await inspectLocalRasterImage(path)
  if ('error' in image) return image
  try {
    return await readInspectedLocalRasterImage(image, maxBytes, requireMatchingExtension)
  } finally {
    await image.handle.close()
  }
}
