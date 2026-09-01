/**
 * Live probe for the X syndication resolver. Not part of `npm test` - it talks
 * to a third-party service, so it is run deliberately:
 *   node test/probe-x.mjs <post-url-or-id> [...]
 * Prints structure only (hosts, bitrates, counts), never post text.
 */
import { syndicationToken, tweetId, variantsFrom } from '../src/background/media.ts'

const inputs = process.argv.slice(2)
if (inputs.length === 0) {
  console.log('usage: node test/probe-x.mjs <post-url-or-id> [...]')
  process.exit(1)
}

for (const input of inputs) {
  const id = /^\d+$/.test(input) ? input : tweetId(input)
  console.log(`\n=== ${input}`)
  if (!id) {
    console.log('  could not extract a post id from that input')
    continue
  }

  const token = syndicationToken(id)
  const endpoint =
    `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`
  console.log(`  id=${id} token=${token}`)

  let response
  try {
    response = await fetch(endpoint)
  } catch (error) {
    console.log(`  network error: ${error.message}`)
    continue
  }
  console.log(`  HTTP ${response.status} ${response.headers.get('content-type') ?? ''}`)
  if (!response.ok) continue

  let payload
  try {
    payload = await response.json()
  } catch {
    console.log('  response was not JSON')
    continue
  }

  // Structure only - deliberately not printing any post text.
  console.log(`  top-level keys: ${Object.keys(payload).sort().join(', ')}`)
  const items = variantsFrom(payload)
  console.log(`  variants parsed: ${items.length}`)
  for (const item of items) {
    const host = (() => { try { return new URL(item.url).host } catch { return '?' } })()
    // X encodes the rendition size in the mp4 path, e.g. /1280x720/.
    const size = /\/(\d{2,4}x\d{2,4})\//.exec(item.url)?.[1] ?? ''
    console.log(`    ${item.kind.padEnd(4)} ${String(item.label).padEnd(12)} ${size.padEnd(10)} ${host}`)
  }

  // For a playlist, list what renditions it actually carries - the mp4 the API
  // hands back is not always the best one available.
  const playlist = items.find((item) => item.kind === 'hls')
  if (!playlist) continue
  try {
    const text = await (await fetch(playlist.url)).text()
    const { parseMaster, isMasterPlaylist } = await import('../src/lib/hls.ts')
    if (!isMasterPlaylist(text)) {
      console.log('  playlist is a media playlist, not a master')
      continue
    }
    console.log('  hls renditions:')
    for (const variant of parseMaster(text, playlist.url)) {
      console.log(`    ${String(variant.resolution ?? '?').padEnd(10)} ${Math.round(variant.bandwidth / 1000)} kbps`)
    }
  } catch (error) {
    console.log(`  could not read the playlist: ${error.message}`)
  }
}
