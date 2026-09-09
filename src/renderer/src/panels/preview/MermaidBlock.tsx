import { useEffect, useRef, useState } from 'react'
import mermaid from 'mermaid'

interface MermaidBlockProps {
  chart: string
  theme: 'light' | 'dark'
}

let mermaidCounter = 0

export default function MermaidBlock({ chart, theme }: MermaidBlockProps): JSX.Element {
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    const id = `mmd-${Date.now()}-${++mermaidCounter}`

    try {
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === 'dark' ? 'dark' : 'default',
        securityLevel: 'loose',
        suppressErrorRendering: true
      })
    } catch (e) {
      console.warn('Failed to initialize mermaid:', e)
    }

    if (!chart.trim()) {
      setSvg('')
      setError(null)
      return
    }

    mermaid
      .render(id, chart)
      .then(({ svg: renderedSvg }) => {
        if (!cancelled) {
          setSvg(renderedSvg)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.warn('Mermaid rendering failed:', err)
          setError(err?.message || 'Invalid Mermaid syntax or failed to render')
          // 清理 mermaid 偶爾在 DOM 遺留的暫存節點
          const errorEl = document.getElementById(id) || document.getElementById(`d${id}`)
          if (errorEl && errorEl.parentNode) {
            errorEl.parentNode.removeChild(errorEl)
          }
        }
      })

    return () => {
      cancelled = true
    }
  }, [chart, theme])

  if (error) {
    return (
      <div className="mermaid-error-box">
        <div className="mermaid-error-header">
          <span className="mermaid-error-dot" />
          <span>Mermaid diagram warning</span>
        </div>
        <div className="mermaid-error-msg">{error}</div>
        <pre className="mermaid-fallback-code">
          <code>{chart}</code>
        </pre>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className="mermaid-loading-box">
        <div className="mermaid-loading-spinner" />
        <span>Rendering diagram…</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-wrapper"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
