import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TurnSummary } from '@cotta/shared'
import { shareAssetsRoot } from './database.js'
import { sanitizeTurnForShare, shareImageKey, turnImagePaths } from './local-image-turn.js'
import { readLocalRasterImage } from './routes/local-image-file.js'
import type { ShareAsset } from './share-store.js'

const EXTENSION: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

// The turn-reference gate (turnImagePaths) is the authorization: only images the shared turn references are frozen,
// matching what the authenticated sharer already viewed live (including confirmed out-of-project images, e.g. /tmp).
/** Reads one in-limit, referenced image's bytes, or null for anything unreadable/oversize. */
async function readShareImage(path: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const loaded = await readLocalRasterImage(path)
  return 'error' in loaded ? null : { bytes: loaded.bytes, mimeType: loaded.mimeType }
}

/**
 * Freezes every referenced local image of a turn into <share-assets>/<token>/ and returns the manifest plus a sanitized
 * snapshot. Each image gets an opaque, path-free key (cotta-asset/<i>) used both as the snapshot's markdown src and the
 * manifest lookup key — the real filesystem path never leaves the server. File names are index-based (no path traversal);
 * unresolvable/oversize → file:null.
 */
export async function materializeShareAssets(token: string, turn: TurnSummary): Promise<{ snapshot: TurnSummary; assets: ShareAsset[] }> {
  const root = shareAssetsRoot(token)
  await mkdir(root, { recursive: true })
  const manifest: ShareAsset[] = []
  const keyBySrc = new Map<string, string>()
  let index = 0
  for (const { src, path } of turnImagePaths(turn)) {
    const key = shareImageKey(index)
    keyBySrc.set(src, key)
    const loaded = path ? await readShareImage(path) : null
    const file = loaded ? `${index}.${EXTENSION[loaded.mimeType] ?? 'bin'}` : null
    if (loaded && file) await writeFile(join(root, file), loaded.bytes)
    manifest.push({ src: key, file })
    index += 1
  }
  return { snapshot: sanitizeTurnForShare(turn, keyBySrc), assets: manifest }
}
