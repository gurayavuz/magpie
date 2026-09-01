# Magpie — user guide

Magpie takes things off web pages and keeps them: screenshots, video, articles, and files converted
into whatever you actually need.

Click the Magpie icon in the toolbar for the quick menu, or open the side panel for everything.

---

## Screenshots

**Full page** captures the entire page, not just what's on screen — it scrolls through and stitches
the result together. Long pages take a while, because Chrome only lets extensions take two
screenshots per second. That's a browser limit, not a fault.

**Visible area** captures just what you can see, instantly.

Every capture goes to a library in the panel where you can save it, copy it, or edit it.

### Editing a screenshot

Press **Edit** on any capture to open it in a full tab.

- **Blur** — drag over anything you want hidden. This genuinely destroys the pixels underneath
  rather than smearing them, so redacted text can't be recovered.
- **Box**, **Arrow**, **Highlight** — point things out.
- **Text** — click, type, press Enter.

⌘Z undoes, ⌘⇧Z redoes. Save downloads it; Copy puts it on the clipboard.

---

## Recording

**Record this tab** starts immediately and records that one tab, including its sound. Because Chrome
requires it, this has to be started from the toolbar menu or by right-clicking the page — a button
inside the panel isn't enough.

**Screen…** lets you pick any screen, window or tab. Start this one from the panel.

A countdown appears first — three seconds by default, cancellable, adjustable or switchable off in
the panel. While recording, a small pill sits on the page showing elapsed time with pause and stop.
Drag it out of the way, or collapse it with the "–" button.

Recordings save as MP4.

**Two things worth knowing.** Recording a *tab* also captures the little control pill, since it's
part of the page being recorded — collapse it first. And macOS can't capture system sound for
screen recordings, so those come out silent; tab recordings keep their audio fine.

### Trimming

Press **Trim** on any recording, set a start and end, and save the clip. It cuts without
re-encoding, so it's fast — but the start lands on the nearest keyframe rather than exactly on the
second you typed.

---

## Media

Paste a link to a post or video and press **Find**.

Some sites — Instagram among them — keep the picture and the sound in *separate* files. When Magpie
spots that, it offers **Save with sound**, which joins them into one playable file. Take that one.

If you open the list of individual files, each says what it is: **"Save without sound"** or
**"Save sound only"**, and the saved filename says so too. A file that plays audio with no picture
is a sound-only track, not a broken download.

Some streams need assembling from hundreds of pieces; you'll see a progress bar.

**Not supported:** DASH streams. Magpie will list one and tell you it can't save it, rather than
handing you a broken file.

---

## Clip

Turns the article you're reading into clean Markdown — no navigation, ads or footers.

You get the title, author, site and word count, plus a preview. **Copy** puts it on the clipboard;
**Save .md** writes a file with the source URL and date at the top, ready for Obsidian or similar.

Works best on articles and blog posts. On things that aren't articles — dashboards, forums, product
pages — it will tell you it couldn't find one rather than hand you a nav bar.

Images are linked, not downloaded, so if the original site removes them the links go dead.

---

## Convert

Choose files and Magpie shows only what's possible with them. Everything runs on your own machine —
nothing is uploaded.

| You have | You can get |
|---|---|
| Images (incl. SVG) | PNG, JPEG, WebP, PDF, ICO — resize, or read any text in them |
| Video | MP4, WebM, GIF, or just the audio as MP3/M4A/WAV |
| Audio | MP3, M4A, WAV |
| PDF | Merge, extract pages, rotate, split, text, page images |
| Scanned PDF | Read the writing (OCR) |
| CSV / TSV | JSON, Excel, Markdown table |
| JSON | CSV |
| Markdown | HTML |
| HTML | Markdown |
| Word (.docx) | Markdown |

**Reading text from pictures.** For a photo or screenshot use **Read text (OCR)**. For a PDF, try
**To text** first — if it comes back empty the pages are scans, so use **Read scan (OCR)** instead.
OCR guesses at words from shapes, so proofread the result; names and numbers are where it slips.

**Video conversion is slow** because it re-encodes — roughly the length of the video. Pulling the
audio out is much quicker.

**Images:** "Max edge" caps the longest side. For SVG it can also scale *up*, since vector art has
no fixed size.

---

## Where files go

Everything lands in your Downloads folder, sorted:

```
Magpie/              screenshots
Magpie/Media/        video and audio
Magpie/Clips/        articles as Markdown
Magpie/Converted/    converted files
```

---

## If something looks wrong

**After updating Magpie**, rebuild and reload it at `chrome://extensions` — press the reload icon on
the card. Code changes need a rebuild; permission changes need that reload too.

**A video plays sound but no picture** — you saved a sound-only track. Look for **Save with sound**.

**QuickTime shows no picture** — try another player (VLC, or drag the file into Chrome). QuickTime
is fussier than most about video files that are otherwise perfectly valid.

**Chrome's own pages can't be captured or recorded.** `chrome://` pages and the Web Store are off
limits to every extension.
