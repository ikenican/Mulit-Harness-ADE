import { useState, useMemo } from 'react'
import './gitGraph.css'
import type { GitGraphNode } from '../../../../preload/index'

interface GitGraphViewProps {
  nodes: GitGraphNode[]
  selectedHash?: string | null
  onSelectCommit?: (hash: string) => void
}

const LANE_COLORS = [
  '#3b82f6', // Blue
  '#8b5cf6', // Purple
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#6366f1'  // Indigo
]

interface LayoutNode extends GitGraphNode {
  rowIndex: number
  lane: number
  color: string
}

interface GraphLink {
  fromX: number
  fromY: number
  toX: number
  toY: number
  color: string
}

const ROW_HEIGHT = 36
const LANE_WIDTH = 18
const OFFSET_X = 14

export default function GitGraphView({
  nodes,
  selectedHash: externalSelectedHash,
  onSelectCommit
}: GitGraphViewProps): JSX.Element {
  const [internalSelectedHash, setInternalSelectedHash] = useState<string | null>(null)
  const currentSelectedHash =
    externalSelectedHash !== undefined ? externalSelectedHash : internalSelectedHash

  // 計算拓撲通道 (Lane calculation) 與連接線 (Links)
  const { layoutNodes, links, maxLane } = useMemo(() => {
    const layoutNodes: LayoutNode[] = []
    const links: GraphLink[] = []
    const lanes: (string | null)[] = []
    let maxLaneIndex = 0

    // 建立 hash -> rowIndex 索引
    const hashToRow = new Map<string, number>()
    nodes.forEach((n, i) => hashToRow.set(n.hash, i))

    nodes.forEach((node, rowIndex) => {
      // 1. 尋找此 commit 預期在哪一個 lane
      let laneIndex = lanes.indexOf(node.hash)
      if (laneIndex === -1) {
        // 沒有預定 lane，找第一個空位或新增 lane
        laneIndex = lanes.indexOf(null)
        if (laneIndex === -1) {
          laneIndex = lanes.length
          lanes.push(node.hash)
        } else {
          lanes[laneIndex] = node.hash
        }
      }

      maxLaneIndex = Math.max(maxLaneIndex, laneIndex)
      const color = LANE_COLORS[laneIndex % LANE_COLORS.length]

      layoutNodes.push({
        ...node,
        rowIndex,
        lane: laneIndex,
        color
      })

      // 2. 清空當前 commit 在 lanes 中的位置
      lanes[laneIndex] = null

      // 3. 把此 commit 的 parents 指派到 lanes
      node.parents.forEach((parentHash, pIdx) => {
        // 若 parent 存在且尚未在 lanes 中
        let pLane = lanes.indexOf(parentHash)
        if (pLane === -1) {
          if (pIdx === 0 && lanes[laneIndex] === null) {
            // 第一個 parent 優先延續當前 lane
            lanes[laneIndex] = parentHash
            pLane = laneIndex
          } else {
            const freeSlot = lanes.indexOf(null)
            if (freeSlot === -1) {
              pLane = lanes.length
              lanes.push(parentHash)
            } else {
              lanes[freeSlot] = parentHash
              pLane = freeSlot
            }
          }
        }

        maxLaneIndex = Math.max(maxLaneIndex, pLane)

        // 若此 parent 也在目前顯示的清單中，計算曲線連接
        const parentRowIndex = hashToRow.get(parentHash)
        if (parentRowIndex !== undefined && parentRowIndex > rowIndex) {
          const fromX = laneIndex * LANE_WIDTH + OFFSET_X
          const fromY = rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
          const toX = pLane * LANE_WIDTH + OFFSET_X
          const toY = parentRowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
          links.push({ fromX, fromY, toX, toY, color })
        }
      })
    })

    return { layoutNodes, links, maxLane: maxLaneIndex }
  }, [nodes])

  const svgWidth = Math.max(60, (maxLane + 1) * LANE_WIDTH + OFFSET_X + 10)
  const svgHeight = nodes.length * ROW_HEIGHT

  const handleRowClick = (hash: string): void => {
    setInternalSelectedHash(hash)
    onSelectCommit?.(hash)
  }

  if (nodes.length === 0) {
    return (
      <div className="git-graph-empty">
        <span>No commits in this branch yet</span>
      </div>
    )
  }

  return (
    <div className="git-graph-container">
      {/* 向量分支圖 SVG 畫布 */}
      <div className="git-graph-svg-wrapper" style={{ width: `${svgWidth}px` }}>
        <svg width={svgWidth} height={svgHeight} className="git-graph-svg">
          {/* 連接線 (Bézier curves) */}
          {links.map((link, idx) => {
            const dy = link.toY - link.fromY
            const path =
              link.fromX === link.toX
                ? `M ${link.fromX} ${link.fromY} L ${link.toX} ${link.toY}`
                : `M ${link.fromX} ${link.fromY} C ${link.fromX} ${link.fromY + dy * 0.5}, ${link.toX} ${link.toY - dy * 0.5}, ${link.toX} ${link.toY}`
            return (
              <path
                key={`link-${idx}`}
                d={path}
                stroke={link.color}
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                opacity={0.8}
              />
            )
          })}

          {/* Commit 節點 */}
          {layoutNodes.map((n) => {
            const cx = n.lane * LANE_WIDTH + OFFSET_X
            const cy = n.rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2
            const isSelected =
              currentSelectedHash === n.hash ||
              Boolean(currentSelectedHash && n.hash.startsWith(currentSelectedHash))

            return (
              <g
                key={`node-${n.hash}`}
                className={`git-graph-node ${isSelected ? 'selected' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  handleRowClick(n.hash)
                }}
              >
                <title>{`${n.hash}: ${n.message}`}</title>
                {/* 擴大點擊區域 */}
                <circle cx={cx} cy={cy} r={14} fill="transparent" />
                {isSelected && (
                  <circle
                    cx={cx}
                    cy={cy}
                    r={8}
                    fill="none"
                    stroke={n.color}
                    strokeWidth={2.5}
                    opacity={0.8}
                    className="git-node-halo"
                  />
                )}
                <circle
                  cx={cx}
                  cy={cy}
                  r={isSelected ? 5.5 : 4.5}
                  fill={n.color}
                  stroke="var(--bg)"
                  strokeWidth={1.5}
                  className="git-node-dot"
                />
              </g>
            )
          })}
        </svg>
      </div>

      {/* Commit 資訊列表 */}
      <div className="git-graph-rows">
        {layoutNodes.map((node) => {
          const isSelected =
            currentSelectedHash === node.hash ||
            Boolean(currentSelectedHash && node.hash.startsWith(currentSelectedHash))
          return (
            <div
              key={node.hash}
              className={`git-graph-row ${isSelected ? 'selected' : ''}`}
              style={{ height: `${ROW_HEIGHT}px` }}
              onClick={() => handleRowClick(node.hash)}
              title={`${node.hash} - ${node.message}`}
            >
              {/* Branch / Tag 徽章標籤 */}
              {node.refs.length > 0 && (
                <div className="git-graph-refs">
                  {node.refs.map((ref, rIdx) => {
                    const isHead = ref.includes('HEAD')
                    const isTag = ref.startsWith('tag:')
                    return (
                      <span
                        key={rIdx}
                        className={`git-graph-tag ${isHead ? 'head' : isTag ? 'tag' : 'branch'}`}
                      >
                        {ref}
                      </span>
                    )
                  })}
                </div>
              )}

              {/* Commit 訊息與雜湊 */}
              <span className="git-graph-msg">{node.message}</span>
              <span className="git-graph-meta">
                <span className="git-graph-hash">{node.hash}</span>
                <span className="git-graph-author">{node.author}</span>
                <span className="git-graph-date">{node.date}</span>
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
