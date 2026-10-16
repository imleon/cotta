export function formatAge(value?: number | null): string {
  if (!value) return '—'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
  if (elapsedSeconds < 60) return 'now'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours}h`
  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays}d`
  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedMonths < 12) return `${elapsedMonths}mo`
  return `${Math.floor(elapsedMonths / 12)}y`
}
