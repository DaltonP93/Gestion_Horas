'use client'
import { useEffect, useRef, useState } from 'react'
import { Bell, Check, X } from 'lucide-react'
import { api, apiUrl } from '@/lib/api'
import { io, Socket } from 'socket.io-client'

interface Notif {
  id: number; type: string; title: string; body: string | null
  link: string | null; read_at: string | null; created_at: string
}

// Si NEXT_PUBLIC_API_URL es relativo/vacío, usá el origin actual para Socket.io
function socketTarget() {
  const u = apiUrl('/')
  if (u.startsWith('/')) {
    if (typeof window !== 'undefined') return window.location.origin
    return 'http://localhost:4000'
  }
  return u.replace(/\/$/, '')
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notif[]>([])
  const [unread, setUnread] = useState(0)
  const socketRef = useRef<Socket | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  async function load() {
    try {
      const r = await api.get('/api/me/notifications', { params: { limit: 20 } })
      setItems(r.data.items || [])
      setUnread(r.data.unread || 0)
    } catch {}
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const token = typeof window !== 'undefined'
      ? (localStorage.getItem('access_token') || localStorage.getItem('token'))
      : null
    if (!token) return
    const s = io(socketTarget(), { auth: { token }, transports: ['websocket', 'polling'] })
    socketRef.current = s
    s.on('notification', (n: Notif) => {
      setItems(prev => [n, ...prev].slice(0, 20))
      setUnread(u => u + 1)
    })
    return () => { s.disconnect() }
  }, [])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  async function markRead(id: number) {
    await api.post(`/api/me/notifications/${id}/read`).catch(() => {})
    setItems(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    setUnread(u => Math.max(0, u - 1))
  }
  async function markAll() {
    await api.post('/api/me/notifications/read-all').catch(() => {})
    setItems(prev => prev.map(n => n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
    setUnread(0)
  }

  return (
    <div ref={wrapperRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label={`Notificaciones${unread ? ` (${unread} sin leer)` : ''}`}
        className="relative p-2 rounded-xl hover:bg-slate-100 text-slate-600 dark:text-white/60 dark:hover:bg-white/[0.06]">
        <Bell size={20} />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-xl border border-slate-100 z-50 dark:bg-white/[0.04] dark:border-white/[0.06]">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
            <h3 className="font-semibold text-slate-900 text-sm dark:text-white">Notificaciones</h3>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button onClick={markAll} className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
                  <Check size={12} /> Marcar todas
                </button>
              )}
              <button onClick={() => setOpen(false)} className="p-1 text-slate-400 hover:text-slate-600 dark:text-white/30">
                <X size={14} />
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-auto">
            {items.length === 0 ? (
              <div className="py-10 text-center text-slate-400 text-sm dark:text-white/30">Sin notificaciones</div>
            ) : items.map(n => (
              <a key={n.id} href={n.link || '#'}
                onClick={() => !n.read_at && markRead(n.id)}
                className={`block px-4 py-3 border-b border-slate-50 hover:bg-slate-50 ${n.read_at ? '' : 'bg-indigo-50/40'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-slate-900 dark:text-white">{n.title}</div>
                  {!n.read_at && <span className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />}
                </div>
                {n.body && <div className="text-xs text-slate-500 mt-0.5 dark:text-white/40">{n.body}</div>}
                <div className="text-[10px] text-slate-400 mt-1 dark:text-white/30">{new Date(n.created_at).toLocaleString()}</div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
