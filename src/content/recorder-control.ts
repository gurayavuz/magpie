/**
 * Floating recording control.
 *
 * Rendered inside a shadow root so no page stylesheet can reach it, and so it
 * cannot inherit a page's font or colours.
 *
 * A caveat worth stating plainly: when recording *this tab*, Chrome captures the
 * rendered tab — including this control. It can be collapsed to a small dot or
 * hidden entirely (the toolbar badge and side panel still stop the recording),
 * but there is no way to overlay a tab and stay out of its own capture.
 */

import { listen, send, type Handlers, type RecordingState } from '@/lib/protocol'

const HOST_ID = 'magpie-recorder-control'

interface Control {
  host: HTMLElement
  timer: number
  render: (state: RecordingState) => void
}

let control: Control | undefined

function elapsedText(state: RecordingState): string {
  if (!state.startedAt) return '0:00'
  const ms = Date.now() - state.startedAt - (state.pausedMs ?? 0)
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function build(): Control {
  const host = document.createElement('div')
  host.id = HOST_ID
  // A very high stacking order, but still below Chrome's own sharing bar.
  host.style.cssText = 'position:fixed;z-index:2147483646;left:16px;bottom:16px;'
  // Open rather than closed: a page can already see and remove the host
  // element, so closed buys little, and open keeps this inspectable and testable.
  const root = host.attachShadow({ mode: 'open' })

  root.innerHTML = `
    <style>
      :host { all: initial; }
      .pill {
        display: flex; align-items: center; gap: 8px;
        padding: 7px 10px 7px 11px; border-radius: 999px;
        background: #16181d; color: #f4f4f5;
        font: 500 12px/1 system-ui, -apple-system, sans-serif;
        box-shadow: 0 4px 16px rgba(0,0,0,.32); cursor: grab;
        user-select: none;
      }
      .pill[data-dragging="true"] { cursor: grabbing; }
      .dot {
        width: 8px; height: 8px; border-radius: 50%; background: #ef4444;
        animation: pulse 1.6s ease-in-out infinite; flex: none;
      }
      .dot[data-paused="true"] { animation: none; background: #a1a1aa; }
      @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
      @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
      .time { font-variant-numeric: tabular-nums; min-width: 34px; }
      button {
        all: unset; cursor: pointer; padding: 3px 7px; border-radius: 6px;
        font: 500 11px system-ui, sans-serif; color: #d4d4d8;
      }
      button:hover { background: rgba(255,255,255,.12); color: #fff; }
      button.stop { color: #fca5a5; }
      .collapsed { width: 14px; height: 14px; border-radius: 50%; background: #ef4444;
        box-shadow: 0 2px 8px rgba(0,0,0,.4); cursor: pointer; }
    </style>
    <div class="pill" part="pill">
      <span class="dot"></span>
      <span class="time">0:00</span>
      <button class="pause"></button>
      <button class="stop">Stop</button>
      <button class="hide" title="Hide this control">–</button>
    </div>
    <div class="collapsed" title="Recording — click to show controls" hidden></div>
  `

  const pill = root.querySelector<HTMLElement>('.pill')!
  const collapsed = root.querySelector<HTMLElement>('.collapsed')!
  const dot = root.querySelector<HTMLElement>('.dot')!
  const time = root.querySelector<HTMLElement>('.time')!
  const pause = root.querySelector<HTMLButtonElement>('.pause')!
  const stop = root.querySelector<HTMLButtonElement>('.stop')!
  const hide = root.querySelector<HTMLButtonElement>('.hide')!

  let current: RecordingState = { active: true, paused: false }

  pause.addEventListener('click', (event) => {
    event.stopPropagation()
    void send(current.paused ? 'record:resume' : 'record:pause', undefined)
  })
  stop.addEventListener('click', (event) => {
    event.stopPropagation()
    void send('record:stop', undefined)
  })
  hide.addEventListener('click', (event) => {
    event.stopPropagation()
    pill.hidden = true
    collapsed.hidden = false
  })
  collapsed.addEventListener('click', () => {
    pill.hidden = false
    collapsed.hidden = true
  })

  // Drag by the pill itself, so it can be moved out of the way of the content
  // being recorded.
  let dragging = false
  let offsetX = 0
  let offsetY = 0
  pill.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).tagName === 'BUTTON') return
    dragging = true
    pill.dataset.dragging = 'true'
    const rect = host.getBoundingClientRect()
    offsetX = event.clientX - rect.left
    offsetY = event.clientY - rect.top
    pill.setPointerCapture(event.pointerId)
  })
  pill.addEventListener('pointermove', (event) => {
    if (!dragging) return
    host.style.left = `${Math.max(0, event.clientX - offsetX)}px`
    host.style.top = `${Math.max(0, event.clientY - offsetY)}px`
    host.style.bottom = 'auto'
  })
  pill.addEventListener('pointerup', (event) => {
    dragging = false
    delete pill.dataset.dragging
    pill.releasePointerCapture(event.pointerId)
  })

  const render = (state: RecordingState) => {
    current = state
    dot.dataset.paused = String(state.paused)
    pause.textContent = state.paused ? 'Resume' : 'Pause'
    time.textContent = elapsedText(state)
  }

  const timer = window.setInterval(() => {
    if (!current.paused) time.textContent = elapsedText(current)
  }, 500)

  document.documentElement.appendChild(host)
  return { host, timer, render }
}

function destroy(): void {
  if (!control) return
  clearInterval(control.timer)
  control.host.remove()
  control = undefined
}

export const recorderControlHandlers: Handlers = {
  'control:show': ({ state }) => {
    control ??= build()
    control.render(state)
  },
  'control:hide': () => destroy(),
}

// A page that navigates away takes its control with it.
window.addEventListener('pagehide', destroy)
