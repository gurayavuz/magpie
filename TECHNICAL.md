# Magpie — technical notes

Chrome MV3 extension. Vite + CRXJS + React + Tailwind v4 + TypeScript.

Written for whoever works on this next, including future me. The second half is the more valuable
part: it records traps that cost real time and would otherwise be rediscovered the hard way.

---

## Layout

| Path | Role |
| --- | --- |
| `src/background/` | Service worker: capture orchestration, media registry, recording, downloads |
| `src/content/` | Injected into pages: measuring, scrolling, overlays, article extraction |
| `src/offscreen/` | Offscreen document: MediaRecorder, and anything the worker cannot host |
| `src/sidepanel/` | Main UI, one panel per section |
| `src/popup/` | Toolbar launcher |
| `src/editor/` | Full-tab screenshot annotation editor |
| `src/lib/` | Typed messaging, IndexedDB stores, converters, ffmpeg, OCR |
| `tools/` | Build-time asset sync, icon generation, UI previews |
| `test/` | End-to-end suite driving a real browser |

**Messaging** is a single typed protocol (`src/lib/protocol.ts`) mapping a message name to its
request and response shapes, so both ends are checked at compile time. Several routers share one
channel and answer only the names they hold, so the worker and content scripts never steal each
other's messages.

**Nothing declared but unimplemented.** Every entry in the protocol has a live implementation and a
caller. This was violated twice during development and both cases were dead weight that read as
features — see *Removed on purpose* below.

---

## Full-page capture

Chrome only exposes the visible viewport via `chrome.tabs.captureVisibleTab`, rate limited to two
calls per second. A full-page shot is therefore scroll-and-stitch:

1. Find what actually scrolls — the document, or an inner container on app-shell sites (X and
   similar pin the document and scroll a `div`). The scroller's viewport rect is reported so the
   stitcher can crop each tile to it.
2. Prime lazy images: walk the page once, flip `loading="lazy"` to eager, wait on `decode()` with a
   2.5s escape hatch so one stalled image cannot hang the capture.
3. **Re-measure after priming** — images that just loaded change the page height.
4. Capture tiles and composite onto an `OffscreenCanvas` in the worker.
5. `fixed` furniture is hidden after the first tile; `sticky` is demoted to `static` so it renders
   once in its natural place rather than vanishing.

Two details that are easy to get wrong:

- **Tiles are drawn at the position the page actually scrolled to**, not the requested one. At the
  end of a page the browser clamps scrolling, so the last tile overlaps the previous one; drawing by
  actual position makes that overlap land on identical pixels instead of duplicating a strip.
- **The capture scale is measured, never assumed.** A tile is *not* reliably
  `viewport × devicePixelRatio` — headless Chrome, browser zoom and capture-size caps all break that.
  A probe tile gives the real ratio, which then drives part planning, source rects and destination
  offsets. Getting this wrong produces a correctly-sized image that is entirely transparent, because
  `drawImage` silently draws nothing when the source rect exceeds the bitmap.

Pages past the ~16384px canvas limit come back as numbered parts. Shots go to IndexedDB rather than
through messaging, which is JSON-only — and the worker has no `URL.createObjectURL`.

---

## Redaction

The blur tool computes each mosaic block's mean colour from pixel data directly.

It does **not** draw the region into a small canvas and scale it back up, which is the usual trick.
A large one-step downscale can take a point-sampling fast path instead of averaging, leaving one
untouched original pixel per block. The result looks blurred but retains structure — measured on a
checkerboard fixture it removed only about half the detail, and text redacted that way can stay
legible. The test asserts pixel variance collapses below 5% of its original value; the shortcut
scores ~50%.

Shapes are stored in image coordinates, never screen coordinates, so the editor previews a very tall
capture scaled down while exporting at full resolution. Redactions sample from the untouched base,
so overlapping ones cannot smear earlier annotations into the mosaic.

---

## Media

Found by pasting a link. Rather than reverse-engineering private APIs, the resolver opens the link
in a background tab and watches what it loads — `chrome.webRequest` sees every media request, which
survives a site reshuffling its endpoints. X posts additionally try the public syndication endpoint,
whose token is derived from the post id rather than issued by a server.

The registry lives in `chrome.storage.session`, because an MV3 worker is evicted aggressively and an
in-memory map would be empty by the time the panel opened. Writes are serialised per tab: several
media requests can land in the same tick and a naive read-modify-write drops all but the last.

**Byte ranges.** Sites stream via range requests, so one file appears under dozens of URLs. Range
parameters are stripped before recording, collapsing them to one entry — and the stripped URL still
resolves to the complete file. A partial response's `content-length` is the slice, not the file, so
sizes come from the total after the slash in `content-range`.

**Separate tracks.** DASH sites serve picture and sound as different files. Each resolved item is
probed for its `vide`/`soun` handler atoms so the panel can offer a joined download and label lone
tracks. A reel typically resolves to a dozen renditions; listing them beside the joined download is
how a silent video gets saved by mistake, so they collapse behind a disclosure.

`.m3u8` is a playlist, not a file. Segments are fetched concurrently but written in playlist order —
out-of-order concatenation gives a corrupt file. Streams with an `EXT-X-MAP` init segment are
fragmented MP4 and concatenate straight into a valid `.mp4`; MPEG-TS ones are rewrapped with ffmpeg.

---

## Recording

`MediaRecorder` and `getUserMedia` are unavailable in a service worker, and the worker is evicted
while idle. Recording therefore runs in the offscreen document, which has a full DOM and lives until
closed; the worker only obtains a stream and tracks state.

Chunks are written to IndexedDB as they arrive, keyed `[recordingId, index]` so they reassemble in
capture order rather than completion order.

Opening the stream and starting the recorder are **separate steps**, so the countdown runs in
between: the stream is live but nothing is written, which is why the countdown never appears in the
recording and cancelling costs nothing.

Capturing tab audio takes it away from the tab, so the track is routed back to the speakers through
an `AudioContext` — otherwise the page goes silent while recording.

---

## ffmpeg and OCR

Both ship with the extension (`tools/sync-ffmpeg.mjs`, `tools/sync-tesseract.mjs`, run by
`prebuild`) rather than being committed or fetched from a CDN, which extension pages forbid. Both
are dynamically imported so nothing loads until used.

ffmpeg operations are stream copies wherever possible — joining tracks, rewrapping containers,
trimming — which is why one dependency closes three gaps and stays fast single-threaded. Convert-panel
video conversion is a real transcode and is slow accordingly.

OCR ships only the LSTM core and the integer-quantised English model (2.8MB against 10MB at similar
accuracy). No non-SIMD fallback: the manifest requires Chrome 116 and SIMD landed in Chrome 91.

---

## Traps

Each of these cost real time. They share a shape: the symptom pointed somewhere other than the cause.

**Entry files sharing a basename.** `src/background/index.ts` and `src/content/index.ts` both
produced a chunk named `index.ts-<hash>`, they collided, and the service worker loaded the *content
script*. Raw messaging worked and `hasListeners()` returned true, but every background message
resolved to `undefined`. Nothing in the build or typecheck flagged it. Entry files now have distinct
names (`service-worker.ts`, `content-script.ts`).

**`desktopCapture` stream ids are bound to their requester.** Passing `targetTab` scopes the stream
to frames *in that tab*; the offscreen document is an extension page, not a frame in any tab, so it
could never consume one. Removing `targetTab` then exposed that a service worker has no window to
parent the picker dialog to, so it cancels instantly with an empty id. Screen capture now calls
`getDisplayMedia` **inside** the offscreen document, which is what the `DISPLAY_MEDIA` offscreen
reason exists for. Measured: offscreen consuming a panel-obtained id fails with *"Error starting tab
capture"*; `getDisplayMedia` in the offscreen document works.

**Blob workers cannot reach extension URLs.** tesseract wraps its worker in a blob by default; a
blob worker has an opaque origin and `importScripts` of a `chrome-extension://` URL fails as
`ERR_FILE_NOT_FOUND` even with the file present *and* web-accessible. `workerBlobURL: false` keeps
it on the extension's own origin. The misleading error sends you hunting for a missing file.

**Manifest changes need an extension reload.** A rebuild rewrites `dist/`, but Chrome reads the
manifest only at load. After adding `wasm-unsafe-eval`, a running instance kept the old policy and
every WASM compile failed deep inside emscripten. `loadFfmpeg` now compiles an eight-byte empty
module first and, on a CSP failure, says to reload the extension.

**`chrome.tabCapture` requires `activeTab`,** granted only when the extension is invoked *on that
tab* — toolbar button, context menu, or shortcut. A click inside the side panel does not count.
Hence the context-menu entry and the guidance in place of a raw Chrome error.

**Programmatic content-script injection must read the manifest.** The bundler rewrites the content
script to a hashed filename, so a hardcoded source path works in dev and fails in every build.

---

## Removed on purpose

- **Scan.** The Media panel was paste-a-link only by request; the DOM scan, `media:list`,
  `media:clear` and `media:scanPage` went with it. The `webRequest` registry stayed — link
  resolution depends on it — and is now internal, tested by reading `chrome.storage.session`.
- **`media:clear`** turned out to be dead already: implemented, wired, called by nothing.
- **Area and element capture** were declared in the protocol with no handler and no UI. Scaffolding
  that reads as a feature is worse than an absent one.

---

## Testing

```bash
npm run test:browser              # once: fetch Chrome for Testing
npm test                          # build, then drive a real browser
node test/run.mjs --only recording  # one section while iterating
```

147 assertions across 14 sections. A full run takes minutes: each section launches its own browser
and the capture tests are bound by Chrome's two-screenshots-per-second limit. Use `--only`.

The suite is deliberately property-based rather than snapshot-based. Capture is verified by sampling
each colour band at its real page offset, so it checks the page-coordinate → image-coordinate
mapping. Redaction is verified by pixel variance. OCR is verified against text the test itself drew.
Conversions are verified by file headers and, for the PDF, by round-tripping known text.

**Stock Chrome disabled `--load-extension` in M137**, so the suite uses Chrome for Testing. Override
with `CHROME_PATH`.

**Not covered:** the video capture itself. Tab capture needs `activeTab`, which only a real toolbar
click grants, and `getDisplayMedia` waits for a user to choose a source — it blocks rather than fails
without a display. Everything around the capture is tested; the capture needs trying by hand.

Two live probes talk to real services and are run deliberately, not as part of `npm test`:

```bash
node test/probe-x.mjs "<post url>"    # X syndication resolver
node test/probe-link.mjs "<url>"      # the general background-tab resolver
```

Both print structure only — kinds, hosts, sizes, track types — never page content.

---

## Distribution

Built to be loaded unpacked. Downloading media from sites like X or Instagram is generally against
their terms, and the Chrome Web Store prohibits listing extensions whose purpose is downloading
content in violation of a site's terms — publishing this with the downloader included would risk
removal.
