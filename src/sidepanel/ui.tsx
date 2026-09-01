/**
 * Shared panel primitives.
 *
 * Every surface in the panel is built from these, so spacing, radius and state
 * colours stay consistent without each panel re-inventing them.
 */

import type { ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium ' +
  'transition-colors disabled:cursor-not-allowed disabled:opacity-45 select-none'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-surface text-ink border border-line hover:bg-surface-hover',
  ghost: 'text-ink-muted hover:bg-surface-hover hover:text-ink',
  danger: 'text-ink-muted hover:bg-danger-soft hover:text-danger',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizing = size === 'sm' ? 'h-7 px-2 text-[11px]' : 'h-8 px-3 text-xs'
  return (
    <button
      type="button"
      className={`${BUTTON_BASE} ${sizing} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Page header inside a section: title plus optional supporting line. */
export function PanelHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 pt-4 pb-3">
      <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-ink-subtle">{hint}</p>}
    </div>
  )
}

export function Card({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={`overflow-hidden rounded-lg border border-line bg-surface ${className}`}
      style={{ boxShadow: 'var(--shadow)' }}
    >
      {children}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-ink-muted">
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  )
}

const CONTROL =
  'h-7 rounded-md border border-line bg-surface px-2 text-[11px] text-ink ' +
  'placeholder:text-ink-subtle focus:border-accent focus:outline-none'

export function Select({ className = '', ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${CONTROL} ${className}`} {...rest} />
}

export function Input({ className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${className}`} {...rest} />
}

/** Inline status line. Errors persist; notices are transient and self-clear. */
export function Message({ tone, children }: { tone: 'error' | 'success' | 'warning'; children: ReactNode }) {
  const tones = {
    error: 'bg-danger-soft text-danger',
    success: 'text-success',
    warning: 'bg-warning-soft text-warning',
  }
  const padded = tone === 'success' ? '' : 'rounded-md px-2 py-1.5'
  return <p className={`text-[11px] leading-snug ${padded} ${tones[tone]}`}>{children}</p>
}

/** Shown when a list has nothing in it yet. */
export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      {icon && <div className="text-ink-subtle opacity-60">{icon}</div>}
      <p className="max-w-[220px] text-[11px] leading-relaxed text-ink-subtle">{children}</p>
    </div>
  )
}

/** Small caps label used to group controls within a scrolling panel. */
export function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-subtle">
      {children}
    </h3>
  )
}
