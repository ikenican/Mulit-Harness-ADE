import { ipcMain } from 'electron'
import simpleGit from 'simple-git'
import path from 'path'
import fs from 'fs/promises'
import { workspace, getWorkspaceForEvent } from '../index'
import type {
  GitStatus,
  GitCommit,
  GitFileChange,
  GitCommitDetail,
  GitCommitFileChange
} from '../../preload/index'

export function registerGitHandlers(): void {
  const getGit = (event?: Electron.IpcMainInvokeEvent) => simpleGit(getWorkspaceForEvent(event))

  // git:status -> GitStatus
  ipcMain.handle('git:status', async (event): Promise<GitStatus> => {
    try {
      const git = getGit(event)
      const isRepo = await git.checkIsRepo()
      if (!isRepo) {
        return { isRepo: false, current: '', staged: [], unstaged: [], untracked: [] }
      }

      const status = await git.status()
      const staged: GitFileChange[] = status.files
        .filter((f) => f.index && f.index.trim() !== '' && f.index !== '?')
        .map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir }))

      const unstaged: GitFileChange[] = status.files
        .filter((f) => f.working_dir && f.working_dir.trim() !== '')
        .map((f) => ({ path: f.path, index: f.index, working_dir: f.working_dir }))

      const untracked: string[] = status.not_added || []

      return {
        isRepo: true,
        current: status.current || '',
        staged,
        unstaged,
        untracked
      }
    } catch {
      return { isRepo: false, current: '', staged: [], unstaged: [], untracked: [] }
    }
  })

  // git:log (limit=50) -> GitCommit[]
  ipcMain.handle('git:log', async (event, limit?: number): Promise<GitCommit[]> => {
    try {
      const git = getGit(event)
      const isRepo = await git.checkIsRepo()
      if (!isRepo) return []

      const maxCount = typeof limit === 'number' && limit > 0 ? limit : 50
      const logResult = await git.log({ maxCount })
      return logResult.all.map((c) => ({
        hash: c.hash.slice(0, 7),
        date: c.date,
        message: c.message,
        author: c.author_name
      }))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.includes('does not have any commits yet') ||
        msg.includes('bad default revision')
      ) {
        return []
      }
      throw new Error(`git:log failed: ${msg}`)
    }
  })

  // git:graph (limit=60) -> GitGraphNode[]
  ipcMain.handle('git:graph', async (event, limit?: number) => {
    try {
      const git = getGit(event)
      const isRepo = await git.checkIsRepo()
      if (!isRepo) return []

      const maxCount = typeof limit === 'number' && limit > 0 ? limit : 60
      const raw = await git.raw([
        'log',
        '--date=short',
        '--format=%h%x09%p%x09%an%x09%ad%x09%d%x09%s',
        '-n',
        String(maxCount)
      ])

      const lines = raw.trim().split(/\r?\n/).filter(Boolean)
      return lines.map((line) => {
        const parts = line.split('\t')
        const hash = parts[0] || ''
        const parents = parts[1] ? parts[1].trim().split(/\s+/).filter(Boolean) : []
        const author = parts[2] || ''
        const date = parts[3] || ''
        const rawRefs = parts[4] ? parts[4].trim().replace(/^\(|\)$/g, '') : ''
        const refs = rawRefs ? rawRefs.split(',').map((r) => r.trim()).filter(Boolean) : []
        const message = parts.slice(5).join('\t') || ''

        return {
          hash,
          parents,
          author,
          date,
          refs,
          message
        }
      })
    } catch {
      return []
    }
  })

  // git:diff (path) -> { head: string; work: string }
  ipcMain.handle(
    'git:diff',
    async (event, filePath: string): Promise<{ head: string; work: string }> => {
      try {
        const ws = getWorkspaceForEvent(event)
        const git = getGit(event)
        let relPath = path.isAbsolute(filePath)
          ? path.relative(ws, filePath)
          : filePath
        relPath = relPath.replace(/\\/g, '/')

        const absPath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(ws, filePath)

        let head = ''
        try {
          head = await git.show([`HEAD:${relPath}`])
        } catch {
          head = ''
        }

        let work = ''
        try {
          work = await fs.readFile(absPath, 'utf-8')
        } catch {
          work = ''
        }

        return { head, work }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`git:diff failed: ${msg}`)
      }
    }
  )

  // git:stage (path) -> git.add(path)
  ipcMain.handle('git:stage', async (event, filePath: string): Promise<void> => {
    try {
      const ws = getWorkspaceForEvent(event)
      const git = getGit(event)
      const relPath = path.isAbsolute(filePath)
        ? path.relative(ws, filePath)
        : filePath
      await git.add(relPath.replace(/\\/g, '/'))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:stage failed: ${msg}`)
    }
  })

  // git:unstage (path) -> git.reset(['--', path])
  ipcMain.handle('git:unstage', async (event, filePath: string): Promise<void> => {
    try {
      const ws = getWorkspaceForEvent(event)
      const git = getGit(event)
      const relPath = path.isAbsolute(filePath)
        ? path.relative(ws, filePath)
        : filePath
      await git.reset(['--', relPath.replace(/\\/g, '/')])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:unstage failed: ${msg}`)
    }
  })

  // git:restore (path) -> git.checkout(['--', path])
  ipcMain.handle('git:restore', async (event, filePath: string): Promise<void> => {
    try {
      const ws = getWorkspaceForEvent(event)
      const git = getGit(event)
      const relPath = path.isAbsolute(filePath)
        ? path.relative(ws, filePath)
        : filePath
      await git.checkout(['--', relPath.replace(/\\/g, '/')])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:restore failed: ${msg}`)
    }
  })

  // git:commit (message) -> git.commit(message)
  ipcMain.handle('git:commit', async (event, message: string): Promise<void> => {
    try {
      if (!message || !message.trim()) {
        throw new Error('Commit message cannot be empty')
      }
      const git = getGit(event)
      await git.commit(message)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:commit failed: ${msg}`)
    }
  })

  // git:branches () -> git.branchLocal() returning { current, all }
  ipcMain.handle('git:branches', async (event): Promise<{ current: string; all: string[] }> => {
    try {
      const git = getGit(event)
      const res = await git.branchLocal()
      return {
        current: res.current || '',
        all: res.all || []
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:branches failed: ${msg}`)
    }
  })

  // git:checkout (branch) -> git.checkout(branch)
  ipcMain.handle('git:checkout', async (event, branch: string): Promise<void> => {
    try {
      const git = getGit(event)
      await git.checkout(branch)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:checkout failed: ${msg}`)
    }
  })

  // git:commitDetails (hash) -> GitCommitDetail
  ipcMain.handle('git:commitDetails', async (event, hash: string): Promise<GitCommitDetail> => {
    try {
      const git = getGit(event)
      const raw = await git.raw([
        'show',
        '--name-status',
        '--format=%H%x09%P%x09%an%x09%ad%x09%s',
        '-n',
        '1',
        hash
      ])
      const lines = raw.trim().split(/\r?\n/)
      if (lines.length === 0) {
        throw new Error('Commit not found')
      }
      const headerParts = lines[0].split('\t')
      const fullHash = headerParts[0] || hash
      const parents = headerParts[1] ? headerParts[1].trim().split(/\s+/).filter(Boolean) : []
      const author = headerParts[2] || ''
      const date = headerParts[3] || ''
      const message = headerParts.slice(4).join('\t') || ''

      const files: GitCommitFileChange[] = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim()
        if (!line) continue
        const parts = line.split('\t')
        if (parts.length >= 2) {
          const rawStatus = parts[0].trim()
          const status = rawStatus[0] || 'M'
          const filePath = (parts[2] || parts[1]).replace(/\\/g, '/')
          files.push({ path: filePath, status })
        }
      }

      return {
        hash: fullHash.slice(0, 7),
        fullHash,
        parents,
        author,
        date,
        message,
        files
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`git:commitDetails failed: ${msg}`)
    }
  })

  // git:commitFileDiff (hash, filePath, parentHash?) -> { original: string; modified: string }
  ipcMain.handle(
    'git:commitFileDiff',
    async (
      event,
      hash: string,
      filePath: string,
      parentHash?: string
    ): Promise<{ original: string; modified: string }> => {
      try {
        const ws = getWorkspaceForEvent(event)
        const git = getGit(event)
        let relPath = path.isAbsolute(filePath)
          ? path.relative(ws, filePath)
          : filePath
        relPath = relPath.replace(/\\/g, '/')

        let parent = parentHash
        if (!parent) {
          try {
            const rawParents = await git.raw(['rev-parse', `${hash}^@`])
            const firstParent = rawParents.trim().split(/\s+/)[0]
            if (firstParent) parent = firstParent
          } catch {
            parent = undefined
          }
        }

        let original = ''
        if (parent) {
          try {
            original = await git.show([`${parent}:${relPath}`])
          } catch {
            original = ''
          }
        }

        let modified = ''
        try {
          modified = await git.show([`${hash}:${relPath}`])
        } catch {
          modified = ''
        }

        // Detect binary file content
        const isBinary = (str: string) => /[\x00-\x08\x0E-\x1F]/.test(str.slice(0, 1000))
        if (isBinary(original) || isBinary(modified)) {
          return {
            original: '[Binary file content cannot be displayed in text diff]',
            modified: '[Binary file content cannot be displayed in text diff]'
          }
        }

        return { original, modified }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new Error(`git:commitFileDiff failed: ${msg}`)
      }
    }
  )
}
