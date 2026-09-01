/**
 * Pre-roll countdown.
 *
 * Shown after the stream is open but before the recorder starts, so the numbers
 * themselves never end up in the recording and backing out costs nothing.
 *
 * The backdrop does not take pointer events — only the cancel button does — so
 * the page stays usable while you arrange whatever you are about to record.
 */

import { listen, send, type Handlers } from '@/lib/protocol'

const HOST_ID = 'magpie-countdown'

interface Countdown {
  host: HTMLElement
  timer: number
}

let countdown: Countdown | undefined

function destroy(): void {
  if (!countdown) return
  clearInterval(countdown.timer)
  countdown.host.remove()
  countdown = undefined
}

function build(seconds: number): Countdown {
  destroy()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
    'display:flex;align-items:center;justify-content:center;'
  // Open rather than closed: a page can already see and remove the host
  // element, so closed buys little, and open keeps this inspectable and testable.
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .wrap { display: flex; flex-direction: column; align-items: center; gap: 18px; }
      .count {
        width: 132px; height: 132px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: rgba(15,17,21,.88); color: #fff;
        font: 600 62px/1 system-ui, -apple-system, sans-serif;
        font-variant-numeric: tabular-nums;
        box-shadow: 0 10px 40px rgba(0,0,0,.35);
        animation: pop .9s ease-out infinite;
      }
      @keyframes pop { 0% { transform: scale(.92); opacity: .75 } 45% { transform: scale(1); opacity: 1 } 100% { transform: scale(.92); opacity: .75 } }
      @media (prefers-reduced-motion: reduce) { .count { animation: none } }
      button {
        all: unset; pointer-events: auto; cursor: pointer;
        padding: 8px 16px; border-radius: 999px;
        background: rgba(15,17,21,.88); color: #f4f4f5;
        font: 500 13px system-ui, -apple-system, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
      }
      button:hover { background: rgba(15,17,21,1); }
    </style>
    <div class="wrap">
      <div class="count"></div>
      <button type="button">Cancel</button>
    </div>
  `

  const count = root.querySelector<HTMLElement>('.count')!
  const cancel = root.querySelector<HTMLButtonElement>('button')!

  let remaining = seconds
  count.textContent = String(remaining)

  cancel.addEventListener('click', () => {
    destroy()
    void send('record:cancel', undefined)
  })

  const timer = window.setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      // The worker removes this when it starts recording; clearing the text
      // avoids showing a stale "0" in the meantime.
      count.textContent = ''
      clearInterval(timer)
      return
    }
    count.textContent = String(remaining)
  }, 1000)

  document.documentElement.appendChild(host)
  return { host, timer }
}

export const countdownHandlers: Handlers = {
  'countdown:show': ({ seconds }) => {
    countdown = build(seconds)
  },
  'countdown:hide': () => destroy(),
}

window.addEventListener('pagehide', destroy)
