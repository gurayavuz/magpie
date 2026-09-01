# Magpie

A Chrome extension that takes things off web pages and keeps them.

- **Screenshots** — full-page or visible area, with an annotation editor including real redaction
- **Recording** — this tab or any screen, with a countdown and an on-page control
- **Media** — paste a post link and download the video, with picture and sound joined into one file
- **Clip** — turn an article into clean Markdown
- **Convert** — images, video, audio, PDF, spreadsheets, documents, and OCR — all on your machine

📖 **[User guide](GUIDE.md)** — what it does and how to use it
🔧 **[Technical notes](TECHNICAL.md)** — architecture, decisions, and the traps worth knowing

---

## Install

```bash
npm install
npm run build
```

Then at `chrome://extensions`: enable **Developer mode**, choose **Load unpacked**, and select the
`dist/` folder.

After a rebuild, press the reload icon on the extension card. Manifest changes always need that
reload — a rebuild alone doesn't re-read it.

## Develop

```bash
npm run dev                          # Vite with HMR
npm run build                        # production build into dist/
npm test                             # end-to-end suite in a real browser
node test/run.mjs --only recording   # one section while iterating
```

`npm run test:browser` fetches Chrome for Testing once, which the suite needs — stock Chrome
disabled the `--load-extension` switch in M137.

The build syncs ffmpeg and the OCR engine out of `node_modules` into `public/`, so `dist/` is
around 45MB. Both are dynamically imported and load only when used.

## A note on media downloads

Built to be loaded unpacked, for personal use. Downloading media from sites like X or Instagram is
generally against their terms, and the Chrome Web Store prohibits listing extensions whose purpose
is downloading content in violation of a site's terms.
