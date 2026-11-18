import { Capacitor } from '@capacitor/core'
import { Browser } from '@capacitor/browser'
import { Share } from '@capacitor/share'
import {
  IconArrowLeft, IconArrowUp, IconBrain, IconCopy, IconMenu2, IconMicrophone, IconPlus, IconRefresh, IconSettings,
  IconShare, IconThumbDown, IconThumbUp, IconVolume, IconVolumeOff, IconWorld, IconX,
} from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createNativeResponse } from '@/native/stream-http'
import { copyText, listenForSpeech, speakText, stopSpeaking } from './native-device'
import deepSeekLogo from '@/static/logos/deepseek-logo-mark-light.svg'

type ChatRole = 'user' | 'assistant'
type Source = { title: string; url: string; snippet?: string }
type ChatAttachment = { fileId: string; name: string; mimeType: string; purpose: string }
type PendingAttachment = ChatAttachment & { localId: string; status: 'uploading' | 'ready' }
type ChatMessage = { id: string; role: ChatRole; content: string; attachments?: ChatAttachment[]; reasoning?: string; sources?: Source[]; serverToolCalls?: unknown[] }
type Chat = { id: string; title: string; updatedAt: number; messages: ChatMessage[] }

const CHAT_STORAGE_KEY = 'deepseek-mobile:chats:v1'
const ACTIVE_CHAT_STORAGE_KEY = 'deepseek-mobile:active-chat:v1'
const API_KEY_STORAGE_KEY = 'deepseek-mobile:api-key:v1'
const API_BASE_URL_STORAGE_KEY = 'deepseek-mobile:api-base-url:v1'
const MODEL_STORAGE_KEY = 'deepseek-mobile:model:v1'
const DEFAULT_MODEL = 'deepseek-flash'
const DEFAULT_API_BASE_URL = 'https://api.deepseek.com'

function readChats(): Chat[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter(
      (chat): chat is Chat =>
        typeof chat?.id === 'string' &&
        typeof chat?.title === 'string' &&
        typeof chat?.updatedAt === 'number' &&
        Array.isArray(chat?.messages)
    )
  } catch {
    return []
  }
}

function readApiKey() {
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

function makeId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function dayLabel(timestamp: number) {
  const date = new Date(timestamp)
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (sameDay) return '今天'
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

function chatCompletionsUrl(baseUrl: string) {
  const url = baseUrl.trim().replace(/\/+$/, '')
  return url.endsWith('/chat/completions') ? url : `${url}/chat/completions`
}

function apiRootUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '')
}

function filePurpose(file: File) {
  const extension = file.name.toLowerCase().split('.').pop() || ''
  if (file.type.startsWith('image/')) return 'user_data'
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx'].includes(extension)) return 'rich_layout_recognition'
  if (['txt', 'md', 'csv', 'json', 'js', 'ts', 'py', 'html', 'xml', 'yaml', 'yml', 'log', 'xlsx', 'xls', 'epub', 'mobi'].includes(extension)) return 'user_data'
  throw new Error(`暂不支持 ${file.name}，请选图片、PDF、Office、文本或表格文件`)
}

async function uploadApiFile(baseUrl: string, apiKey: string, file: File): Promise<ChatAttachment> {
  const purpose = filePurpose(file)
  const limit = purpose === 'user_data' && file.type.startsWith('image/') ? 64 : purpose === 'user_data' ? 32 : 100
  if (file.size > limit * 1024 * 1024) throw new Error(`${file.name} 超过 ${limit} MB 限制`)
  const form = new FormData()
  form.append('purpose', purpose)
  form.append('file', file, file.name)
  const response = await fetch(`${apiRootUrl(baseUrl)}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    let reason = raw
    try { reason = JSON.parse(raw)?.error?.message || raw } catch { /* retain response text */ }
    throw new Error(reason || `上传失败（${response.status}）`)
  }
  const result = await response.json()
  return { fileId: result.id, name: result.filename || file.name, mimeType: file.type || 'application/octet-stream', purpose }
}

function openExternal(url: string) {
  if (Capacitor.isNativePlatform()) void Browser.open({ url })
  else window.open(url, '_blank', 'noopener,noreferrer')
}

async function openApiStream(
  apiKey: string,
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  options: { webSearch: boolean; deepThinking: boolean },
  signal: AbortSignal,
  onUpdate: (update: { text?: string; reasoning?: string; sources?: Source[]; serverToolCalls?: unknown[] }) => void
) {
  const body = JSON.stringify({
    model,
    stream: true,
    thinking: { type: options.deepThinking ? 'enabled' : 'disabled' },
    ...(options.webSearch ? { tools: [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }] } : {}),
    messages: messages.map((message) => ({
      role: message.role,
      content: message.role === 'user' && message.attachments?.length
        ? [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...message.attachments.map(({ fileId }) => ({ type: 'file', file_id: fileId })),
          ]
        : message.content,
      ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
      ...(message.serverToolCalls ? { server_tool_calls: message.serverToolCalls } : {}),
    })),
  })
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  const response = Capacitor.isNativePlatform()
    ? await createNativeResponse({ url: chatCompletionsUrl(baseUrl), method: 'POST', headers, body }, { signal })
    : await fetch(chatCompletionsUrl(baseUrl), { method: 'POST', headers, body, signal })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text
    try {
      const error = JSON.parse(text)
      detail = error?.error?.message || text
    } catch {
      // Keep the plain response body as the detail.
    }
    throw new Error(detail || `请求失败（${response.status}）`)
  }

  if (!response.body) throw new Error('服务器没有返回可读取的数据')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() || ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let event: any
        try {
          event = JSON.parse(data)
        } catch {
          // Ignore incomplete or non-JSON keep-alive frames.
          continue
        }
        if (event?.error?.message) throw new Error(event.error.message)
        try {
          const delta = event?.choices?.[0]?.delta
          if (!delta) continue
          const update: { text?: string; reasoning?: string; sources?: Source[]; serverToolCalls?: unknown[] } = {}
          if (typeof delta.content === 'string') update.text = delta.content
          if (typeof delta.reasoning_content === 'string') update.reasoning = delta.reasoning_content
          if (Array.isArray(delta.server_tool_calls)) {
            update.serverToolCalls = delta.server_tool_calls
            const sources = delta.server_tool_calls.flatMap((step: any) =>
              (step.calls || []).flatMap((call: any) => (call.sources || []).map((source: any) => ({
                title: source.title || source.site_name || source.url,
                url: source.url,
                snippet: source.snippet,
              })))
            )
            if (sources.length) update.sources = sources
          }
          if (update.text || update.reasoning || update.sources || update.serverToolCalls) onUpdate(update)
        } catch (error) {
          if (error instanceof Error) throw error
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export default function DeepSeekMobileApp() {
  const [chats, setChats] = useState<Chat[]>(readChats)
  const [activeChatId, setActiveChatId] = useState(() => localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY) || '')
  const [apiKey, setApiKey] = useState(readApiKey)
  const [draftKey, setDraftKey] = useState(apiKey)
  const [apiBaseUrl, setApiBaseUrl] = useState(() => localStorage.getItem(API_BASE_URL_STORAGE_KEY) || DEFAULT_API_BASE_URL)
  const [model, setModel] = useState(() => localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL)
  const [draftApiBaseUrl, setDraftApiBaseUrl] = useState(apiBaseUrl)
  const [draftModel, setDraftModel] = useState(model)
  const [draft, setDraft] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(!apiKey)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [webSearch, setWebSearch] = useState(false)
  const [deepThinking, setDeepThinking] = useState(false)
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [speakingMessageId, setSpeakingMessageId] = useState('')
  const [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({})
  const [copyNotice, setCopyNotice] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeChat = useMemo(() => chats.find((chat) => chat.id === activeChatId), [activeChatId, chats])

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chats))
  }, [chats])

  useEffect(() => {
    if (activeChatId) localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId)
    else localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY)
  }, [activeChatId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [activeChat?.messages])

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`
  }, [draft])

  useEffect(() => () => abortRef.current?.abort(), [])

  const startNewChat = useCallback(() => {
    abortRef.current?.abort()
    setSending(false)
    setError('')
    setActiveChatId('')
    setSidebarOpen(false)
    setDraft('')
    setPendingAttachments([])
  }, [])

  const announce = useCallback((message: string) => {
    setCopyNotice(message)
    window.setTimeout(() => setCopyNotice(''), 1800)
  }, [])

  const readAloud = useCallback(async (id: string, content: string) => {
    if (speakingMessageId === id) {
      await stopSpeaking()
      setSpeakingMessageId('')
      return
    }
    try {
      await stopSpeaking()
      setSpeakingMessageId(id)
      await speakText(content)
    } catch (error) {
      announce(error instanceof Error ? error.message : '朗读失败，请检查系统语音设置')
    } finally {
      setSpeakingMessageId('')
    }
  }, [announce, speakingMessageId])

  const startVoiceInput = useCallback(async () => {
    if (isListening) return
    setIsListening(true)
    try {
      const result = await listenForSpeech()
      const text = result.text.trim()
      if (text) setDraft((current) => current ? `${current} ${text}` : text)
    } catch (error) {
      announce(error instanceof Error ? error.message : '语音输入失败')
    } finally {
      setIsListening(false)
    }
  }, [announce, isListening])

  const uploadFiles = useCallback((fileList: FileList | null) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    if (!apiKey) {
      setDraftKey('')
      setSettingsOpen(true)
      announce('先配置 API Key，再上传文件')
      return
    }
    for (const file of files) {
      const localId = makeId()
      const placeholder: PendingAttachment = {
        fileId: '',
        localId,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        purpose: '',
        status: 'uploading',
      }
      setPendingAttachments((current) => [...current, placeholder])
      void uploadApiFile(apiBaseUrl, apiKey, file).then((attachment) => {
        setPendingAttachments((current) => current.map((item) => item.localId === localId
          ? { ...item, ...attachment, status: 'ready' }
          : item))
      }).catch((uploadError) => {
        setPendingAttachments((current) => current.filter((item) => item.localId !== localId))
        setError(uploadError instanceof Error ? uploadError.message : `${file.name} 上传失败`)
      })
    }
  }, [announce, apiBaseUrl, apiKey])

  const saveSettings = useCallback(() => {
    const next = draftKey.trim()
    const nextBaseUrl = draftApiBaseUrl.trim() || DEFAULT_API_BASE_URL
    const nextModel = draftModel.trim() || DEFAULT_MODEL
    setApiKey(next)
    setApiBaseUrl(nextBaseUrl)
    setModel(nextModel)
    if (next) localStorage.setItem(API_KEY_STORAGE_KEY, next)
    else localStorage.removeItem(API_KEY_STORAGE_KEY)
    localStorage.setItem(API_BASE_URL_STORAGE_KEY, nextBaseUrl)
    localStorage.setItem(MODEL_STORAGE_KEY, nextModel)
    setError('')
    setSettingsOpen(false)
  }, [draftApiBaseUrl, draftKey, draftModel])

  const submit = useCallback(async (regenerate = false) => {
    const text = regenerate ? '' : draft.trim()
    if ((!regenerate && !text && pendingAttachments.length === 0) || sending || pendingAttachments.some((file) => file.status !== 'ready')) return
    if (!apiKey) {
      setDraftKey('')
      setSettingsOpen(true)
      return
    }

    setError('')
    if (!regenerate) {
      setDraft('')
      setPendingAttachments([])
    }
    const now = Date.now()
    const id = activeChatId || makeId()
    let previousMessages = activeChat?.messages || []
    if (regenerate && previousMessages.at(-1)?.role === 'assistant') previousMessages = previousMessages.slice(0, -1)
    const previousUser = regenerate ? [...previousMessages].reverse().find((message) => message.role === 'user') : undefined
    if (regenerate && !previousUser) return
    const userMessage: ChatMessage = previousUser || {
      id: makeId(),
      role: 'user',
      content: text,
      attachments: pendingAttachments.map(({ localId: _localId, status: _status, ...attachment }) => attachment),
    }
    const assistantMessage: ChatMessage = { id: makeId(), role: 'assistant', content: '' }
    const nextChat: Chat = {
      id,
      title: activeChat?.title || text.replace(/\s+/g, ' ').slice(0, 36) || userMessage.attachments?.[0]?.name || '文件对话',
      updatedAt: now,
      messages: regenerate ? [...previousMessages, assistantMessage] : [...previousMessages, userMessage, assistantMessage],
    }
    setActiveChatId(id)
    setChats((current) => [nextChat, ...current.filter((chat) => chat.id !== id)])
    setSending(true)
    const controller = new AbortController()
    abortRef.current = controller
    const history = regenerate ? previousMessages : [...previousMessages, userMessage]
    const requestOptions = { webSearch, deepThinking }
    let generatedText = ''

    try {
      await openApiStream(apiKey, apiBaseUrl, model, history, requestOptions, controller.signal, (update) => {
        generatedText += update.text || ''
        setChats((current) =>
          current.map((chat) =>
            chat.id === id
              ? {
                  ...chat,
                  updatedAt: Date.now(),
                  messages: chat.messages.map((message) =>
                    message.id === assistantMessage.id
                      ? {
                          ...message,
                          content: message.content + (update.text || ''),
                          reasoning: (message.reasoning || '') + (update.reasoning || ''),
                          sources: update.sources ? [...(message.sources || []), ...update.sources] : message.sources,
                          serverToolCalls: update.serverToolCalls
                            ? [...(message.serverToolCalls || []), ...update.serverToolCalls]
                            : message.serverToolCalls,
                        }
                      : message
                  ),
                }
              : chat
          )
        )
      })
      if (voiceEnabled && generatedText) void readAloud(assistantMessage.id, generatedText)
    } catch (requestError) {
      if (!controller.signal.aborted) {
        const message = requestError instanceof Error ? requestError.message : '请求失败，请检查网络或 API Key'
        setError(message)
        setChats((current) =>
          current.map((chat) =>
            chat.id === id
              ? { ...chat, messages: chat.messages.filter((item) => item.id !== assistantMessage.id || item.content) }
              : chat
          )
        )
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setSending(false)
    }
  }, [activeChat, activeChatId, apiBaseUrl, apiKey, deepThinking, draft, model, pendingAttachments, readAloud, sending, voiceEnabled, webSearch])

  const copyMessage = useCallback(async (content: string) => {
    try {
      await copyText(content)
      announce('已复制')
    } catch {
      announce('复制失败')
    }
  }, [announce])

  const groupedChats = useMemo(() => {
    const groups = new Map<string, Chat[]>()
    for (const chat of [...chats].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const label = dayLabel(chat.updatedAt)
      groups.set(label, [...(groups.get(label) || []), chat])
    }
    return [...groups.entries()]
  }, [chats])

  if (settingsOpen) {
    return (
      <main className="mobile-app settings-screen">
        <header className="settings-header">
          <button className="icon-button" aria-label="返回" onClick={() => setSettingsOpen(false)}>
            <IconArrowLeft size={23} stroke={1.8} />
          </button>
          <h1>设置</h1>
          <span className="header-spacer" />
        </header>
        <section className="settings-content">
          <h2>API 设置</h2>
          <p className="settings-caption">支持 DeepSeek 及兼容 OpenAI Chat Completions 的 API。配置保存在本机。</p>
          <label className="setting-label" htmlFor="api-base-url">API 地址</label>
          <input
            id="api-base-url"
            className="setting-input"
            autoCapitalize="none"
            spellCheck={false}
            value={draftApiBaseUrl}
            onChange={(event) => setDraftApiBaseUrl(event.currentTarget.value)}
            placeholder="https://api.deepseek.com"
          />
          <label className="setting-label" htmlFor="api-model">模型名称</label>
          <input
            id="api-model"
            className="setting-input"
            autoCapitalize="none"
            spellCheck={false}
            value={draftModel}
            onChange={(event) => setDraftModel(event.currentTarget.value)}
            placeholder="deepseek-flash"
          />
          <label className="setting-label" htmlFor="api-key">API Key</label>
          <div className="key-field">
            <input
              id="api-key"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              type={showKey ? 'text' : 'password'}
              value={draftKey}
              onChange={(event) => setDraftKey(event.currentTarget.value)}
              placeholder="sk-..."
            />
            <button className="key-visibility" onClick={() => setShowKey((value) => !value)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <button className="primary-button" onClick={saveSettings}>
            保存
          </button>
          <button
            className="text-button danger-button"
            onClick={() => {
              setDraftKey('')
              setApiKey('')
              localStorage.removeItem(API_KEY_STORAGE_KEY)
            }}
          >
            清除 API Key
          </button>
          <a className="api-key-link" href="https://platform.deepseek.com/api_keys" onClick={(event) => { event.preventDefault(); openExternal(event.currentTarget.href) }}>
            获取 DeepSeek API Key
          </a>
          <section className="about-section">
            <h2>关于</h2>
            <a href="https://qm.qq.com/q/SaZ0OFHYgQ" onClick={(event) => { event.preventDefault(); openExternal(event.currentTarget.href) }}>加入 QQ 群聊</a>
            <a href="https://github.com/Jiaozi06/deepseek-box" onClick={(event) => { event.preventDefault(); openExternal(event.currentTarget.href) }}>GitHub 开源仓库</a>
            <p>© Jiaozi</p>
          </section>
        </section>
      </main>
    )
  }

  return (
    <main className="mobile-app chat-screen">
      <header className="chat-header">
        <button className="icon-button" aria-label="打开会话列表" onClick={() => setSidebarOpen(true)}>
          <IconMenu2 size={23} stroke={1.8} />
        </button>
        <div className="model-title" aria-label={activeChat?.title || 'DeepSeek'}>
          <span>{activeChat?.title || 'DeepSeek'}</span>
        </div>
        <button className="icon-button" aria-label={voiceEnabled ? '关闭自动朗读' : '开启自动朗读'} onClick={() => setVoiceEnabled((value) => !value)}>
          {voiceEnabled ? <IconVolume size={23} stroke={1.8} /> : <IconVolumeOff size={23} stroke={1.8} />}
        </button>
        <button className="icon-button" aria-label="新对话" onClick={startNewChat}>
          <IconPlus size={23} stroke={1.8} />
        </button>
      </header>

      <section ref={scrollRef} className="message-list" aria-live="polite">
        {activeChat?.messages.map((message) => (
          <article key={message.id} className={`message-row ${message.role === 'user' ? 'user-row' : 'assistant-row'}`}>
            {message.role === 'user' && message.attachments?.length ? (
              <div className="message-attachment-list">
                {message.attachments.map((attachment) => (
                  <div key={attachment.fileId} className="message-attachment">
                    <span className="attachment-file-icon">{attachment.mimeType.startsWith('image/') ? '图片' : '文件'}</span>
                    <span>{attachment.name}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {message.role === 'assistant' && message.reasoning && (
              <details className="thinking-panel" open={sending && message.id === activeChat?.messages.at(-1)?.id}>
                <summary><IconBrain size={17} /> 深度思考</summary>
                <div className="markdown-body reasoning-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.reasoning}</ReactMarkdown></div>
              </details>
            )}
            <div className={`message-text ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}>
              {message.role === 'user'
                ? message.content
                : message.content
                  ? <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
                    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) openExternal(href) }}>{children}</a>,
                    }}>{message.content}</ReactMarkdown></div>
                  : (sending && message.role === 'assistant' ? <span className="typing-dot" /> : null)}
            </div>
            {message.role === 'assistant' && message.sources?.length ? (
              <div className="source-list">
                {message.sources.map((source, index) => (
                  <a key={`${source.url}-${index}`} className="source-card" href={source.url} onClick={(event) => { event.preventDefault(); openExternal(source.url) }}>
                    <strong>{source.title}</strong>
                    {source.snippet && <span>{source.snippet}</span>}
                    <small>{new URL(source.url).hostname}</small>
                  </a>
                ))}
              </div>
            ) : null}
            {message.role === 'assistant' && message.content && (
              <div className="message-actions" aria-label="回答操作">
                <button className="action-button" aria-label="复制回答" onClick={() => void copyMessage(message.content)}><IconCopy size={21} stroke={1.8} /></button>
                <button className={`action-button ${feedback[message.id] === 'up' ? 'selected' : ''}`} aria-label="赞同" onClick={() => setFeedback((value) => ({ ...value, [message.id]: value[message.id] === 'up' ? undefined as never : 'up' }))}><IconThumbUp size={21} stroke={1.8} /></button>
                <button className={`action-button ${feedback[message.id] === 'down' ? 'selected' : ''}`} aria-label="不赞同" onClick={() => setFeedback((value) => ({ ...value, [message.id]: value[message.id] === 'down' ? undefined as never : 'down' }))}><IconThumbDown size={21} stroke={1.8} /></button>
                <button className={`action-button ${speakingMessageId === message.id ? 'selected' : ''}`} aria-label={speakingMessageId === message.id ? '停止朗读' : '朗读回答'} onClick={() => void readAloud(message.id, message.content)}>
                  {speakingMessageId === message.id ? <IconVolumeOff size={21} stroke={1.8} /> : <IconVolume size={21} stroke={1.8} />}
                </button>
                <button className="action-button" aria-label="分享回答" onClick={() => void Share.share({ title: 'DeepSeek 回答', text: message.content })}><IconShare size={21} stroke={1.8} /></button>
                <button className="action-button regenerate-action" aria-label="重新生成" disabled={sending} onClick={() => void submit(true)}><IconRefresh size={22} stroke={1.8} /></button>
              </div>
            )}
          </article>
        ))}
        {error && <div className="error-message">{error}</div>}
      </section>

      <footer className="composer-area">
        <div className="composer">
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            accept="image/*,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.csv,.json,.js,.ts,.py,.html,.xml,.yaml,.yml,.log,.xlsx,.xls,.epub,.mobi"
            onChange={(event) => {
              uploadFiles(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
          {pendingAttachments.length > 0 && (
            <div className="pending-files">
              {pendingAttachments.map((attachment) => (
                <div key={attachment.localId} className={`pending-file ${attachment.status}`}>
                  <span>{attachment.status === 'uploading' ? '上传中' : attachment.mimeType.startsWith('image/') ? '图片' : '文件'}</span>
                  <span className="pending-file-name">{attachment.name}</span>
                  <button aria-label={`移除 ${attachment.name}`} onClick={() => setPendingAttachments((current) => current.filter((item) => item.localId !== attachment.localId))}>×</button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (sending) {
                  abortRef.current?.abort()
                  setSending(false)
                } else {
                  void submit()
                }
              }
            }}
            placeholder={isListening ? '正在聆听…' : '发消息给 DeepSeek'}
            aria-label="发消息给 DeepSeek"
          />
          <div className="composer-toolbar">
            <div className="composer-options">
              <button className={`option-chip ${deepThinking ? 'active' : ''}`} onClick={() => setDeepThinking((value) => !value)} aria-pressed={deepThinking}>
                <IconBrain size={18} stroke={1.8} /> 深度思考
              </button>
              <button className={`option-chip search-chip ${webSearch ? 'active' : ''}`} onClick={() => setWebSearch((value) => !value)} aria-pressed={webSearch}>
                <IconWorld size={18} stroke={1.8} /> 联网搜索
              </button>
            </div>
            <div className="composer-actions">
              <button className="composer-tool-button" aria-label="添加图片或文件" onClick={() => fileInputRef.current?.click()}>
                <IconPlus size={23} stroke={1.8} />
              </button>
              <button className={`composer-tool-button microphone-button ${isListening ? 'listening' : ''}`} aria-label="语音输入" disabled={isListening || sending} onClick={() => void startVoiceInput()}>
                <IconMicrophone size={22} stroke={1.8} />
              </button>
              {(sending || draft.trim() || pendingAttachments.length > 0) && (
                <button
                  className={`send-button ${sending ? 'stop-button' : ''}`}
                  aria-label={sending ? '停止生成' : '发送消息'}
                  disabled={!sending && (pendingAttachments.some((file) => file.status !== 'ready') || (!draft.trim() && pendingAttachments.length === 0))}
                  onClick={() => {
                    if (sending) {
                      abortRef.current?.abort()
                      setSending(false)
                    } else {
                      void submit()
                    }
                  }}
                >
                  {sending ? <span className="stop-square" /> : <IconArrowUp size={21} stroke={2.2} />}
                </button>
              )}
            </div>
          </div>
        </div>
        <p className="disclaimer">AI 生成内容仅供参考</p>
      </footer>

      {sidebarOpen && (
        <div className="drawer-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSidebarOpen(false)
        }}>
          <aside className="conversation-drawer" aria-label="会话列表">
            <div className="drawer-header">
              <img src={deepSeekLogo} alt="DeepSeek" />
              <button className="icon-button" aria-label="关闭" onClick={() => setSidebarOpen(false)}>
                <IconX size={22} stroke={1.8} />
              </button>
            </div>
            <button className="new-chat-button" onClick={startNewChat}>
              <IconPlus size={20} stroke={1.8} />
              <span>新对话</span>
            </button>
            <div className="history-list">
              {groupedChats.map(([label, group]) => (
                <section key={label} className="history-group">
                  <h2>{label}</h2>
                  {group.map((chat) => (
                    <button
                      key={chat.id}
                      className={`history-item ${chat.id === activeChatId ? 'selected' : ''}`}
                      onClick={() => {
                        setActiveChatId(chat.id)
                        setSidebarOpen(false)
                        setError('')
                      }}
                    >
                      {chat.title}
                    </button>
                  ))}
                </section>
              ))}
            </div>
            <button className="settings-button" onClick={() => {
              setDraftKey(apiKey)
              setDraftApiBaseUrl(apiBaseUrl)
              setDraftModel(model)
              setSidebarOpen(false)
              setSettingsOpen(true)
            }}>
              <IconSettings size={20} stroke={1.8} />
              <span>设置</span>
              <span className={`key-status ${apiKey ? 'configured' : ''}`}>{apiKey ? 'API Key 已设置' : '设置 API Key'}</span>
            </button>
          </aside>
        </div>
      )}
      {copyNotice && <div className="copy-notice" role="status">{copyNotice}</div>}
    </main>
  )
}
