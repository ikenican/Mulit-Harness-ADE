import type { AgentId } from '../../../preload/index'

interface AgentMarkProps {
  agent: AgentId | 'shell' | 'powershell' | 'cmd' | 'bash'
  size?: number
  className?: string
}

export default function AgentMark({ agent, size = 16, className = '' }: AgentMarkProps): JSX.Element {
  const norm = agent.toLowerCase()

  if (norm.includes('claude')) {
    // Official Anthropic Claude Asterisk / Starburst Mark
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        className={`agent-mark mark-claude ${className}`}
        style={{ color: '#D97706', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      >
        <path d="M12 2C12.5523 2 13 2.44772 13 3V8.58579L16.2929 5.29289C16.6834 4.90237 17.3166 4.90237 17.7071 5.29289C18.0976 5.68342 18.0976 6.31658 17.7071 6.70711L14.4142 10H20C20.5523 10 21 10.4477 21 11C21 11.5523 20.5523 12 20 12H14.4142L17.7071 15.2929C18.0976 15.6834 18.0976 16.3166 17.7071 16.7071C17.3166 17.0976 16.6834 17.0976 16.2929 16.7071L13 13.4142V19C13 19.5523 12.5523 20 12 20C11.4477 20 11 19.5523 11 19V13.4142L7.70711 16.7071C7.31658 17.0976 6.68342 17.0976 6.29289 16.7071C5.90237 16.3166 5.90237 15.6834 6.29289 15.2929L9.58579 12H4C3.44772 12 3 11.5523 3 11C3 10.4477 3.44772 10 4 10H9.58579L6.29289 6.70711C5.90237 6.31658 5.90237 5.68342 6.29289 5.29289C6.68342 4.90237 7.31658 4.90237 7.70711 5.29289L11 8.58579V3C11 2.44772 11.4477 2 12 2Z" />
      </svg>
    )
  }

  if (norm.includes('codex')) {
    // Official OpenAI Codex Rosette / Spiral Mark
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        className={`agent-mark mark-codex ${className}`}
        style={{ color: '#10A37F', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      >
        <path d="M22.28 9.87a5.98 5.98 0 0 0-.52-4.93 6.05 6.05 0 0 0-6.19-2.92 6.03 6.03 0 0 0-4.54-2 6.08 6.08 0 0 0-5.8 4.25 6.02 6.02 0 0 0-3.99 2.9 6.05 6.05 0 0 0 .74 6.85 5.99 5.99 0 0 0 .52 4.93 6.05 6.05 0 0 0 6.19 2.92 6.03 6.03 0 0 0 4.54 2 6.08 6.08 0 0 0 5.8-4.25 6.02 6.02 0 0 0 3.99-2.9 6.05 6.05 0 0 0-.74-6.85zM12 20.4a4.5 4.5 0 0 1-2.92-1.07l.15-.09 4.85-2.8a.78.78 0 0 0 .39-.68v-6.84l2.06 1.19v5.79a4.52 4.52 0 0 1-4.53 4.5zM3.9 16.48a4.5 4.5 0 0 1-.55-3.07l.16.1 4.85 2.8a.77.77 0 0 0 .78 0l5.92-3.42v2.38l-5.01 2.9a4.53 4.53 0 0 1-6.15-1.69zM2.84 8.7a4.5 4.5 0 0 1 2.37-2l-.01.17v5.6a.78.78 0 0 0 .39.68l5.92 3.42-2.06 1.19-5.02-2.9A4.52 4.52 0 0 1 2.84 8.7zm15.82 2.6l-5.92-3.42 2.06-1.19 5.01 2.9a4.52 4.52 0 0 1-1.15 7.62v-5.23a.78.78 0 0 0-.39-.68zm2.5-2.7a4.5 4.5 0 0 1 .55 3.07l-.16-.1-4.85-2.8a.77.77 0 0 0-.78 0l-5.92 3.42v-2.38l5.01-2.9a4.53 4.53 0 0 1 6.15 1.69zM8.84 10.74l2.06-1.19 2.06 1.19v2.38l-2.06 1.19-2.06-1.19zM12 3.6a4.5 4.5 0 0 1 2.92 1.07l-.15.09-4.85 2.8a.78.78 0 0 0-.39.68v6.84L7.47 13.9V8.11A4.52 4.52 0 0 1 12 3.6z" />
      </svg>
    )
  }

  if (norm.includes('antigravity') || norm.includes('agy')) {
    // Official Google DeepMind Gemini 4-Point Curved Diamond Spark
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="currentColor"
        className={`agent-mark mark-antigravity ${className}`}
        style={{ color: '#7C3AED', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
      >
        <path d="M12 1C12 7.075 7.075 12 1 12C7.075 12 12 16.925 12 23C12 16.925 16.925 12 23 12C16.925 12 12 7.075 12 1Z" />
      </svg>
    )
  }

  // Shell / Terminal Prompt Icon
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`agent-mark mark-shell ${className}`}
      style={{ color: 'var(--fg-dim)', display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}
