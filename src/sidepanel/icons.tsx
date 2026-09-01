/**
 * Line icons, drawn on a 24px grid with a 1.75px stroke.
 *
 * Inline rather than from an icon package: there are only a handful, they need
 * to inherit `currentColor` for theming, and a dependency would outweigh them.
 */

interface IconProps {
  size?: number
  className?: string
}

function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const CameraIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.7a1 1 0 0 0 .83-.45l.94-1.4A1 1 0 0 1 9.8 3.7h4.4a1 1 0 0 1 .83.45l.94 1.4a1 1 0 0 0 .83.45h1.7A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
    <circle cx="12" cy="12.2" r="3.4" />
  </Svg>
)

export const PlayIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 5.5A1.5 1.5 0 0 1 6.2 4.2l11.6 6.5a1.5 1.5 0 0 1 0 2.6L6.2 19.8A1.5 1.5 0 0 1 4 18.5Z" />
  </Svg>
)

export const ClipIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 3.5h8.5L19 8v12.5H6Z" />
    <path d="M14 3.5V8h5" />
    <path d="M9 12.5h6M9 16h4" />
  </Svg>
)

export const ConvertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 8h13" />
    <path d="m13.5 4.5 3.5 3.5-3.5 3.5" />
    <path d="M20 16H7" />
    <path d="m10.5 12.5-3.5 3.5 3.5 3.5" />
  </Svg>
)

export const DownloadIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10.5 4.5 4 4.5-4" />
    <path d="M4.5 19.5h15" />
  </Svg>
)

export const CopyIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="9" y="9" width="11" height="11" rx="2.2" />
    <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
  </Svg>
)

export const PenIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4 20h4l10-10a2.5 2.5 0 0 0-3.5-3.5L4.5 16.5Z" />
    <path d="M13.5 7 17 10.5" />
  </Svg>
)

export const TrashIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M4.5 6.5h15" />
    <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
    <path d="M6.5 6.5 7.5 20a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13.5" />
  </Svg>
)

export const SearchIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Svg>
)

export const FileIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M6 3.5h8.5L19 8v12.5H6Z" />
    <path d="M14 3.5V8h5" />
  </Svg>
)

export const AlertIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M12 4.5 21 19.5H3Z" />
    <path d="M12 10v4" />
    <path d="M12 16.8v.2" />
  </Svg>
)

export const RecordIcon = (props: IconProps) => (
  <Svg {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </Svg>
)

export const StopIcon = (props: IconProps) => (
  <Svg {...props}>
    <rect x="6" y="6" width="12" height="12" rx="2.5" />
  </Svg>
)

export const PauseIcon = (props: IconProps) => (
  <Svg {...props}>
    <path d="M9.5 5v14M14.5 5v14" />
  </Svg>
)
