import { defineManifest } from '@crxjs/vite-plugin'
import pkg from '../package.json'

export default defineManifest({
  manifest_version: 3,
  name: 'Magpie',
  version: pkg.version,
  description: 'Take what you need off any page: full-page screenshots, video, articles as Markdown, and file conversion.',
  icons: {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Magpie',
  },
  side_panel: { default_path: 'src/sidepanel/index.html' },
  background: { service_worker: 'src/background/service-worker.ts', type: 'module' },
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/content-script.ts'],
      run_at: 'document_idle',
      all_frames: false,
    },
  ],
  permissions: [
    'activeTab',
    'tabs',
    'scripting',
    'storage',
    'unlimitedStorage',
    'downloads',
    'offscreen',
    'tabCapture',
    'desktopCapture',
    'sidePanel',
    'contextMenus',
    'clipboardWrite',
    'webRequest',
    'webNavigation',
  ],
  host_permissions: ['<all_urls>'],
  web_accessible_resources: [
    {
      resources: [
        'src/editor/index.html',
        'assets/*',
        // tesseract.js runs its engine in a blob worker, which has an opaque
        // origin and can only reach resources declared here. ffmpeg is listed
        // for the same reason should its worker ever load them directly.
        'tesseract/*',
        'ffmpeg/*',
      ],
      matches: ['<all_urls>'],
    },
  ],
  // WebAssembly needs an explicit allowance under the MV3 default policy.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  minimum_chrome_version: '116',
})
