import { useCallback, useEffect, useState } from 'react'
import type { CaptureResult } from '@/lib/protocol'
import { deleteShot, getShot, listShots } from '@/lib/shot-store'

export interface ShotWithPreview extends CaptureResult {
  previewUrl: string
}

/**
 * Loads captured shots out of IndexedDB and keeps an object URL alive for each
 * preview. URLs are revoked whenever the list is replaced, so a long session
 * does not leak a few hundred megabytes of blobs.
 */
export function useShots() {
  const [shots, setShots] = useState<ShotWithPreview[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const metas = await listShots()
    const withPreviews = await Promise.all(
      metas.map(async (meta) => {
        const stored = await getShot(meta.id)
        return { ...meta, previewUrl: stored ? URL.createObjectURL(stored.blob) : '' }
      }),
    )

    setShots((previous) => {
      for (const shot of previous) {
        if (shot.previewUrl) URL.revokeObjectURL(shot.previewUrl)
      }
      return withPreviews
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Revoke everything still outstanding when the panel closes.
  useEffect(
    () => () => {
      setShots((previous) => {
        for (const shot of previous) {
          if (shot.previewUrl) URL.revokeObjectURL(shot.previewUrl)
        }
        return []
      })
    },
    [],
  )

  const remove = useCallback(
    async (id: string) => {
      await deleteShot(id)
      await refresh()
    },
    [refresh],
  )

  return { shots, loading, refresh, remove }
}
