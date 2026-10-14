'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'

type Status = { phase: string; accountConfigured: boolean; connection: string; room: { id: string | null; name: string | null }; audioAdapterConfigured: boolean; playback: string; queueLength: number; tts: string; recovery: { status: string; attempt: number; maxAttempts: number } }
type Room = { id: string; gmeId: string; topic: string; campus: string; ownerName?: string | null; participantCount: number | null }
type QueueItem = { queueId: string; title: string; durationSeconds: number; requestedBy: string; status: string }
type MusicQueue = { status: string; attached: boolean; queue: { current: QueueItem | null; upcoming: QueueItem[]; length: number; repeat: boolean; loop: boolean }; error: string | null }
type ChatMessage = { id: number; direction: 'incoming' | 'outgoing'; sender: string; text: string; createdAt: number }
type Settings = Record<string, string | number | boolean | string[]>
type Config = {
  account: { configured: boolean }
  adapter: { configured: boolean; type: string }
  groq: { configured: boolean; model: string }
  azureTts: { configured: boolean; region: string }
  settings: Settings
  warning?: string
}
type Tab = 'เพลง' | 'แชต' | 'ผู้ใช้' | 'ตั้งค่า'
type DirectoryUser = { uuid: string; name: string; previousNames: string[] }

function getApiBase() {
  if (typeof window === 'undefined') return 'http://localhost:5353'
  return process.env.NEXT_PUBLIC_BOT_API || `${window.location.protocol}//${window.location.hostname}:5353`
}

export default function Home() {
  const base = useMemo(getApiBase, [])
  const [tab, setTab] = useState<Tab>('เพลง')
  const [status, setStatus] = useState<Status | null>(null)
  const [config, setConfig] = useState<Config | null>(null)
  const [token, setToken] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomMembers, setRoomMembers] = useState<Record<string, string[]>>({})
  const [roomId, setRoomId] = useState('')
  const [roomTopic, setRoomTopic] = useState('')
  const [musicRequest, setMusicRequest] = useState('')
  const [musicQueue, setMusicQueue] = useState<MusicQueue | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [usersCount, setUsersCount] = useState(0)
  const [usersQuery, setUsersQuery] = useState('')

  async function refreshStatus() {
    try {
      const response = await fetch(`${base}/api/status`, { cache: 'no-store' })
      if (!response.ok) throw new Error()
      setStatus(await response.json())
    } catch { setNotice('เชื่อมต่อ API ไม่ได้ ตรวจว่าเริ่มเซิร์ฟเวอร์แล้ว') }
  }

  async function refreshQueue(value = token) {
    if (!value) return
    try {
      const response = await fetch(`${base}/api/music/queue`, { headers: { Authorization: `Bearer ${value}` }, cache: 'no-store' })
      if (response.ok) setMusicQueue(await response.json() as MusicQueue)
    } catch { /* Queue refresh is best-effort; room controls remain usable. */ }
  }

  async function refreshChatMessages(value = token) {
    if (!value) { setChatMessages([]); return }
    try {
      const response = await fetch(`${base}/api/chat/messages`, { headers: { Authorization: `Bearer ${value}` }, cache: 'no-store' })
      if (response.ok) {
        const body = await response.json() as { connected: boolean; messages: ChatMessage[] }
        setChatMessages(body.connected ? body.messages : [])
      }
    } catch { /* The bounded room buffer is best-effort and is never persisted in the browser. */ }
  }

  async function loadConfig(value: string) {
    const response = await fetch(`${base}/api/config`, { headers: { Authorization: `Bearer ${value}` }, cache: 'no-store' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error || 'ยืนยัน owner token ไม่สำเร็จ')
    const data = body as Config
    setConfig(data)
  }

  useEffect(() => {
    void refreshStatus()
    const statusTimer = window.setInterval(() => void refreshStatus(), 5000)
    const saved = sessionStorage.getItem('ymb-owner-token') || ''
    setToken(saved)
    if (saved) {
      void loadConfig(saved).catch(() => sessionStorage.removeItem('ymb-owner-token'))
      void refreshQueue(saved)
    }
    return () => window.clearInterval(statusTimer)
  // Load once for the current browser session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadUsers(query = usersQuery) {
    if (!token) return
    setBusy(true); setNotice('')
    try {
      const params = new URLSearchParams({ limit: '1000' })
      if (query.trim()) params.set('q', query.trim())
      const response = await fetch(`${base}/api/users?${params}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
      setUsers(body.users as DirectoryUser[])
      setUsersCount(body.count as number)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (tab !== 'ผู้ใช้' || !token) return
    void loadUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token])

  useEffect(() => {
    if (tab !== 'แชต' || !token) return
    let cancelled = false
    const refresh = async () => {
      try {
        const response = await fetch(`${base}/api/chat/messages`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!response.ok) return
        const body = await response.json() as { connected: boolean; messages: ChatMessage[] }
        if (!cancelled) setChatMessages(body.connected ? body.messages : [])
      } catch { /* The chat is read-only until the next successful poll. */ }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [base, tab, token])

  async function connectOwner(event: FormEvent) {
    event.preventDefault(); setBusy(true); setNotice('')
    try { await loadConfig(token); sessionStorage.setItem('ymb-owner-token', token); await refreshQueue(token); setNotice('ยืนยัน owner token แล้ว') }
    catch (error) { setNotice(error instanceof Error ? error.message : 'ยืนยันไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault(); if (!token || !config) return
    setBusy(true); setNotice('')
    try {
      const response = await fetch(`${base}/api/config`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: config.settings }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'บันทึกไม่สำเร็จ')
      setConfig(body); setNotice(body.warning || 'บันทึก settings แล้ว')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'บันทึกไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function loadRooms() {
    if (!token) return
    setBusy(true); setNotice('')
    try {
      const response = await fetch(`${base}/api/rooms`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'โหลดรายชื่อห้องไม่สำเร็จ')
      const list = body.rooms as Room[]
      setRooms(list)
      setRoomMembers({})
      setNotice(`พบห้องสาธารณะ ${list.length} ห้อง`)
      void loadRoomMembers(list)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'โหลดรายชื่อห้องไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  // Fetch each room's occupant names with a small concurrency limit so a large
  // list doesn't fire dozens of requests at once; names appear as they arrive.
  async function loadRoomMembers(list: Room[]) {
    if (!token) return
    const queue = [...list]
    const worker = async () => {
      while (queue.length) {
        const room = queue.shift()
        if (!room) break
        try {
          const r = await fetch(`${base}/api/room/${room.id}/participants`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
          if (!r.ok) continue
          const b = await r.json()
          const names = (b.participants as { name: string }[] | undefined)?.map(p => p.name).filter(Boolean) ?? []
          setRoomMembers(prev => ({ ...prev, [room.id]: names }))
        } catch { /* skip this room */ }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
  }

  async function createPublicRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!token || !roomTopic.trim()) return
    setBusy(true); setNotice('กำลังสร้างห้องสาธารณะและเชื่อมต่อ…')
    try {
      const response = await fetch(`${base}/api/rooms/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: roomTopic.trim() }),
      })
      const body = await response.json() as { room: Room; connected: { roomId: string } }
      if (!response.ok) throw new Error((body as unknown as { error?: string }).error || 'สร้างห้องไม่สำเร็จ')
      setRoomTopic('')
      setRooms(current => [body.room, ...current.filter(room => room.id !== body.room.id)])
      setNotice(`สร้างและเชื่อมต่อห้อง ${body.connected.roomId} แล้ว`)
      await refreshStatus()
      await refreshQueue()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'สร้างห้องไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  function autoJoinFollowing() {
    setNotice('สุ่มเข้าห้องถูกปิดไว้จนกว่าจะตรวจยืนยันช่อง speaker ว่างก่อนเข้าห้องได้')
  }

  async function joinRoom(id: string) {
    if (!token || !id.trim()) return
    setBusy(true); setNotice('กำลังเชื่อมต่อห้อง…')
    try {
      const response = await fetch(`${base}/api/room/join`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: id.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'เข้าห้องไม่สำเร็จ')
      setRoomId('')
      setNotice(`เชื่อมต่อห้อง ${body.connected.roomId} แล้ว`)
      await refreshStatus()
      await refreshQueue()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'เข้าห้องไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function leaveRoom() {
    if (!token) return
    setBusy(true); setNotice('กำลังออกจากห้อง…')
    try {
      const response = await fetch(`${base}/api/room/leave`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'ออกจากห้องไม่สำเร็จ')
      setNotice(body.left ? 'ออกจากห้องแล้ว' : 'ไม่มีห้องที่เชื่อมต่ออยู่')
      await refreshStatus()
      await refreshQueue()
    } catch (error) { setNotice(error instanceof Error ? error.message : 'ออกจากห้องไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function requestMusic(event: FormEvent) {
    event.preventDefault()
    if (!token || !musicRequest.trim()) return
    setBusy(true); setNotice('กำลังค้นหาและเพิ่มเพลง…')
    try {
      const response = await fetch(`${base}/api/music/request`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: musicRequest.trim() }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'เพิ่มเพลงไม่สำเร็จ')
      setMusicRequest('')
      setNotice(`เพิ่มเพลง ${body.added} รายการแล้ว`)
      await Promise.all([refreshStatus(), refreshQueue()])
    } catch (error) { setNotice(error instanceof Error ? error.message : 'เพิ่มเพลงไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function sendChat(event: FormEvent) {
    event.preventDefault()
    if (!token || !chatDraft.trim() || status?.connection !== 'joined') return
    setBusy(true); setNotice('')
    try {
      const response = await fetch(`${base}/api/chat/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: chatDraft }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'ส่งข้อความไม่สำเร็จ')
      setChatDraft('')
      await refreshChatMessages()
      setNotice('ส่งข้อความแล้ว')
    } catch (error) { setNotice(error instanceof Error ? error.message : 'ส่งข้อความไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  async function musicAction(action: 'skip' | 'pause' | 'resume' | 'stop') {
    if (!token) return
    setBusy(true); setNotice('')
    try {
      const response = await fetch(`${base}/api/music/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error || 'คำสั่งเพลงไม่สำเร็จ')
      setNotice(action === 'stop' ? 'หยุดเพลงและล้างคิวแล้ว' : 'อัปเดตสถานะเพลงแล้ว')
      await Promise.all([refreshStatus(), refreshQueue()])
    } catch (error) { setNotice(error instanceof Error ? error.message : 'คำสั่งเพลงไม่สำเร็จ') }
    finally { setBusy(false) }
  }

  function setSetting(key: string, value: string | number | boolean | string[]) {
    setConfig(current => current ? { ...current, settings: { ...current.settings, [key]: value } } : current)
  }
  const value = (key: string) => config?.settings[key]
  const canControlMusic = Boolean(token && status?.connection === 'joined' && status.audioAdapterConfigured)

  return <main className="shell">
    <header className="header"><div><p className="eyebrow">LOCAL CONTROL PANEL</p><h1>Yello Music Bot</h1></div><span className="status-pill"><i className={status?.accountConfigured ? 'dot ready' : 'dot'} />{status?.phase || 'กำลังตรวจสถานะ'}</span></header>
    <nav className="tabs" aria-label="เมนูหลัก">{(['เพลง', 'แชต', 'ผู้ใช้', 'ตั้งค่า'] as Tab[]).map(item => <button key={item} className={tab === item ? 'tab active' : 'tab'} onClick={() => setTab(item)}>{item}</button>)}</nav>
    {notice && <div className="notice" role="status">{notice}</div>}

    {!token && <form className="card owner-card" onSubmit={connectOwner}><h2>ยืนยันสิทธิ์เจ้าของ</h2><p>ใส่ token จากไฟล์ local <code>owner-token.txt</code> บนเครื่องที่รันบอท</p><div className="inline-form"><input aria-label="Owner token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="Owner token" /><button className="primary" disabled={busy || !token}>ยืนยัน</button></div></form>}

    {tab === 'เพลง' && <section className="card"><div className="section-heading"><div><p className="eyebrow">PLAYBACK</p><h2>ควบคุมเพลง</h2></div><span className="badge">{status?.recovery.status === 'waiting' || status?.recovery.status === 'recovering' ? `กำลังกู้คืน ${status.recovery.attempt}/${status.recovery.maxAttempts}` : status?.recovery.status === 'exhausted' ? 'กู้คืนไม่สำเร็จ · เลือกห้องใหม่' : status?.connection || 'ยังไม่เชื่อมต่อ'}</span></div><div className="stats"><div><span>เพลง</span><strong>{status?.playback || 'idle'}</strong></div><div><span>ในคิว</span><strong>{status?.queueLength ?? 0}</strong></div><div><span>Audio adapter</span><strong>{status?.audioAdapterConfigured ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า'}</strong></div></div><p className="muted">{status?.room?.name ? `ห้องปัจจุบัน: ${status.room.name}` : 'เลือกห้องเพื่อเชื่อมต่อ YelloTalk'} · เล่นเพลงได้เมื่อเชื่อม adapter เสียงใน config.local.json</p><div className="button-row"><button onClick={() => void loadRooms()} disabled={busy || !token}>โหลดห้องสาธารณะ</button><button onClick={() => void autoJoinFollowing()} disabled={busy || !token}>สุ่มเข้าห้องของคนที่ติดตาม</button>{status?.connection === 'joined' && <button onClick={() => void leaveRoom()} disabled={busy}>ออกจากห้อง</button>}<button onClick={() => void musicAction('skip')} disabled={busy || !canControlMusic || !musicQueue?.queue.current}>ข้ามเพลง</button>{status?.playback === 'paused' ? <button onClick={() => void musicAction('resume')} disabled={busy || !canControlMusic}>เล่นต่อ</button> : <button onClick={() => void musicAction('pause')} disabled={busy || !canControlMusic || status?.playback !== 'playing'}>พักเพลง</button>}<button onClick={() => void musicAction('stop')} disabled={busy || !canControlMusic}>หยุดและล้างคิว</button></div><p className="muted">สุ่มเลือกเฉพาะห้องสาธารณะของบัญชีที่ติดตาม; โหมดสุ่มห้อง public ที่ตรวจ speaker ว่างยังปิดไว้จนกว่าจะยืนยันวิธี preflight ได้</p><form className="inline-form" onSubmit={requestMusic}><input aria-label="YouTube song or search" value={musicRequest} onChange={event => setMusicRequest(event.target.value)} placeholder="ค้นหาเพลงหรือวาง YouTube URL" disabled={busy || !canControlMusic} /><button className="primary" disabled={busy || !canControlMusic || !musicRequest.trim()}>เพิ่มเพลง</button></form><form className="inline-form" onSubmit={createPublicRoom}><input aria-label="ชื่อห้องสาธารณะ" maxLength={100} value={roomTopic} onChange={event => setRoomTopic(event.target.value)} placeholder="ชื่อห้องสาธารณะ (ใช้ topic แบบเดิม)" disabled={busy || !token} /><button className="primary" disabled={busy || !token || !roomTopic.trim()}>สร้างห้อง</button></form><p className="muted">สร้างห้องสาธารณะและเชื่อมต่อทันที โดยใช้ topic เป็นชื่อห้อง ไม่มีคำอธิบายแยก</p><div className="inline-form"><input aria-label="Room ID" value={roomId} onChange={event => setRoomId(event.target.value)} placeholder="หรือใส่ Room ID" disabled={busy || !token} /><button onClick={() => void joinRoom(roomId)} disabled={busy || !token || !roomId.trim()}>เชื่อมต่อ</button></div>{musicQueue?.queue.current && <p className="muted">กำลังเล่น: {musicQueue.queue.current.title}</p>}{musicQueue?.queue.upcoming.length ? <div className="room-list queue-list">{musicQueue.queue.upcoming.map((item, index) => <div className="room-row" key={item.queueId}><div><strong>{index + 1}. {item.title}</strong><span className="muted">{Math.ceil(item.durationSeconds / 60)} นาที · {item.requestedBy || 'ผู้ใช้'}</span></div></div>)}</div> : null}{rooms.length > 0 && <div className="room-list">{rooms.map(room => <div className="room-row" key={room.id}><div><strong>{room.topic || room.id}</strong><span className="muted">{room.ownerName || room.campus}{room.participantCount == null ? '' : ` · ${room.participantCount} คน`}</span>{roomMembers[room.id]?.length ? <span className="member-chips">{roomMembers[room.id].slice(0, 20).map((name, index) => <span className="member-chip" key={index}>{name}</span>)}{roomMembers[room.id].length > 20 ? <span className="member-chip more">+{roomMembers[room.id].length - 20}</span> : null}</span> : null}</div><button onClick={() => void joinRoom(room.id)} disabled={busy || status?.room?.id === room.id}>{status?.room?.id === room.id ? 'เชื่อมต่ออยู่' : 'เข้าห้อง'}</button></div>)}</div>}</section>}

    {tab === 'แชต' && <section className="card"><div className="section-heading"><div><p className="eyebrow">ROOM CHAT</p><h2>แชตสด</h2></div><span className="badge">{status?.connection === 'joined' ? 'เชื่อมต่ออยู่' : status?.accountConfigured ? 'รอเชื่อมต่อห้อง' : 'ยังไม่มีบัญชี'}</span></div><div className="chat-transcript" aria-label="ข้อความล่าสุดในห้อง" aria-live="polite">{chatMessages.length ? chatMessages.map(message => <article className={`chat-message ${message.direction}`} key={message.id}><div><strong>{message.sender}</strong><time>{new Date(message.createdAt).toLocaleTimeString()}</time></div><p>{message.text}</p></article>) : <div className="empty-chat">ข้อความจะแสดงเมื่อเชื่อมต่อห้องแล้ว<br />เก็บไว้ชั่วคราวใน RAM สูงสุด 100 ข้อความ</div>}</div><form className="inline-form" onSubmit={sendChat}><input aria-label="พิมพ์ข้อความถึงห้อง" maxLength={800} value={chatDraft} onChange={event => setChatDraft(event.target.value)} disabled={busy || !token || status?.connection !== 'joined'} placeholder="พิมพ์ข้อความถึงห้อง" /><button className="primary" disabled={busy || !token || status?.connection !== 'joined' || !chatDraft.trim()}>ส่ง</button></form><p className="muted">ส่งผ่าน owner token เท่านั้น; ข้อความจากเว็บไม่เรียกคำสั่งเพลงและไม่บันทึกลงไฟล์</p></section>}

    {tab === 'ผู้ใช้' && <section className="card"><div className="section-heading"><div><p className="eyebrow">USER DIRECTORY</p><h2>ฐานข้อมูลผู้ใช้</h2></div><span className="badge">{usersCount} UUID</span></div><p className="muted">เก็บอัตโนมัติทุกครั้งที่บอทเห็นชื่อ (เจ้าของห้อง · คนในห้อง · คนเข้า/ออก) — เก็บชื่อปัจจุบันและชื่อที่เคยใช้ ต่อ 1 UUID</p><form className="inline-form" onSubmit={event => { event.preventDefault(); void loadUsers(usersQuery) }}><input aria-label="ค้นหาผู้ใช้" value={usersQuery} onChange={event => setUsersQuery(event.target.value)} placeholder="ค้นหาชื่อ / ชื่อเก่า / UUID" disabled={busy || !token} /><button className="primary" disabled={busy || !token}>ค้นหา</button><button type="button" onClick={() => { setUsersQuery(''); void loadUsers('') }} disabled={busy || !token}>ล้าง</button></form>{users.length > 0 ? <div className="room-list">{users.map(user => <div className="room-row" key={user.uuid}><div><strong>{user.name || '(ไม่มีชื่อ)'}</strong><span className="muted">{user.uuid}</span>{user.previousNames.length ? <span className="member-chips">{user.previousNames.map((name, index) => <span className="member-chip" key={index}>{name}</span>)}</span> : null}</div></div>)}</div> : <p className="muted">{token ? 'ยังไม่มีข้อมูล — เปิดแท็บเพลงแล้วโหลดห้อง/เข้าห้อง เพื่อให้บอทเริ่มเก็บชื่อ' : 'ใส่ owner token ก่อน'}</p>}</section>}

    {tab === 'ตั้งค่า' && <div className="settings-grid">
      <section className="card form-card"><div><p className="eyebrow">LOCAL CONFIGURATION</p><h2>บัญชีและบริการ</h2></div><p className="muted">เพื่อไม่ส่งข้อมูลลับผ่านเว็บ ให้แก้ JWT, UUID, adapter token, Groq/Azure keys, ชื่อเรียก และ persona ใน <code>config.local.json</code> บนเครื่องที่รันบอทเท่านั้น</p><p>บัญชี YelloTalk: <strong>{config?.account.configured ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า'}</strong></p><p>Audio adapter ({config?.adapter.type || 'native'}): <strong>{config?.adapter.configured ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า'}</strong></p><p>Groq: <strong>{config?.groq.configured ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า'}</strong></p><p>Azure TTS: <strong>{config?.azureTts.configured ? 'ตั้งค่าแล้ว' : 'ยังไม่ตั้งค่า'}</strong></p><p className="muted">ต้องติดตั้ง/เริ่ม GME adapter แยกต่างหากก่อนเปิด playback; chat/TTS ยังอยู่ระหว่างย้ายระบบ</p></section>

      <form className="card form-card" onSubmit={saveSettings}><div><p className="eyebrow">PREFERENCES</p><h2>ค่าตั้งเพลงและบอท</h2></div><p className="muted">TTS ต้องมี Azure และ adapter ที่รองรับ speech effects ส่วนแชต/ดวงตอบเมื่อเรียกชื่อบอทเท่านั้น; ข้อความทักทายใช้เฉพาะการเปลี่ยนสมาชิกทีละคนและไม่เก็บประวัติ</p>{!config && <p className="muted">ยืนยัน owner token เพื่อโหลด settings</p>}
        <label>Volume เพลง<input type="number" min={0} max={100} value={Number(value('volume') ?? 80)} onChange={event => setSetting('volume', Number(event.target.value))} /></label>
        <label>Format<select value={String(value('musicFormat') ?? 'm4a')} onChange={event => setSetting('musicFormat', event.target.value)}><option value="m4a">m4a</option><option value="hq">hq</option><option value="mp3">mp3</option></select></label>
        <label>คุณภาพเสียงห้อง<select value={String(value('roomQuality') ?? 'standard')} onChange={event => setSetting('roomQuality', event.target.value)}><option value="fluency">Fluency</option><option value="standard">Standard</option><option value="hq">HQ</option></select></label>
        <label>ความยาวเพลงสูงสุด (วินาที)<input type="number" min={60} max={86400} value={Number(value('maxTrackDurationSeconds') ?? 3600)} onChange={event => setSetting('maxTrackDurationSeconds', Number(event.target.value))} /></label>
        <label>คำห้ามเพลง คั่นด้วย comma<input value={Array.isArray(value('musicBlockedKeywords')) ? (value('musicBlockedKeywords') as string[]).join(', ') : ''} onChange={event => setSetting('musicBlockedKeywords', event.target.value.split(',').map(item => item.trim()).filter(Boolean))} /></label>
        {([
          ['autoplay', 'เปิดเล่นต่อเมื่อคิวว่าง'], ['repeat', 'เล่นเพลงเดิมซ้ำ'], ['loop', 'วนเพลงกลับท้ายคิว'],
          ['ttsEnabled', 'อ่านข้อความทั่วไปด้วย TTS'], ['chatRepliesEnabled', 'ตอบคุยเล่นเมื่อเรียกชื่อ'],
          ['fortuneRepliesEnabled', 'ตอบดูดวงเมื่อเรียกชื่อ'], ['aiReplyTtsEnabled', 'อ่านคำตอบ AI ด้วย TTS'],
          ['greetingsEnabled', 'ทักเมื่อมีสมาชิกเข้าทีละคน'], ['farewellsEnabled', 'บอกลาเมื่อสมาชิกออกทีละคน'],
        ] as const).map(([key, label]) => <label className="check-row" key={key}><span>{label}</span><input type="checkbox" checked={Boolean(value(key))} onChange={event => setSetting(key, event.target.checked)} /></label>)}
        <label>ข้อความทักทาย<textarea rows={2} maxLength={180} placeholder="ยินดีต้อนรับ {name}" value={String(value('greetingMessage') ?? '')} onChange={event => setSetting('greetingMessage', event.target.value)} /></label><label>ข้อความบอกลา<textarea rows={2} maxLength={180} placeholder="ลาก่อน {name}" value={String(value('farewellMessage') ?? '')} onChange={event => setSetting('farewellMessage', event.target.value)} /></label>
        <label>เสียง TTS<input value={String(value('ttsVoice') ?? '')} onChange={event => setSetting('ttsVoice', event.target.value)} /></label><label>ความเร็ว TTS<input type="number" min={0.5} max={1.5} step={0.05} value={Number(value('ttsSpeed') ?? 1)} onChange={event => setSetting('ttsSpeed', Number(event.target.value))} /></label><label>Pitch TTS<input type="number" min={-50} max={50} value={Number(value('ttsPitch') ?? 0)} onChange={event => setSetting('ttsPitch', Number(event.target.value))} /></label><label>ความดัง TTS<input type="number" min={0} max={100} value={Number(value('ttsVolume') ?? 80)} onChange={event => setSetting('ttsVolume', Number(event.target.value))} /></label>
        <button className="primary" disabled={busy || !token || !config}>บันทึก settings</button>
      </form>
    </div>}
    <footer>Yello Music Bot · Local/LAN · {base}</footer>
  </main>
}
