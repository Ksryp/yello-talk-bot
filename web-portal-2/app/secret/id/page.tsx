'use client'

import { FormEvent, useEffect, useMemo, useState } from 'react'

type DirectoryUser = { uuid: string; name: string; previousNames: string[] }

const TOKEN_KEY = 'ymb-owner-token'

function getApiBase() {
  if (typeof window === 'undefined') return 'http://localhost:5353'
  return process.env.NEXT_PUBLIC_BOT_API || `${window.location.protocol}//${window.location.hostname}:5353`
}

export default function UserDirectory() {
  const base = useMemo(getApiBase, [])
  const [token, setToken] = useState('')
  const [authed, setAuthed] = useState(false)
  const [checking, setChecking] = useState(true)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [usersCount, setUsersCount] = useState(0)
  const [usersQuery, setUsersQuery] = useState('')

  // The API enforces the owner token on /api/users; this page shows nothing
  // until a request with the token has succeeded.
  async function loadUsers(ownerToken: string, query: string) {
    const params = new URLSearchParams({ limit: '1000' })
    if (query.trim()) params.set('q', query.trim())
    const response = await fetch(`${base}/api/users?${params}`, { headers: { Authorization: `Bearer ${ownerToken}` }, cache: 'no-store' })
    const body = await response.json().catch(() => ({}))
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('owner token ไม่ถูกต้อง'), { unauthorized: true })
    if (!response.ok) throw new Error(body.error || 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
    setUsers(body.users as DirectoryUser[])
    setUsersCount(body.count as number)
  }

  function signOut(message = '') {
    sessionStorage.removeItem(TOKEN_KEY)
    setAuthed(false); setToken(''); setUsers([]); setUsersCount(0); setNotice(message)
  }

  async function run(query: string, ownerToken = token) {
    setBusy(true); setNotice('')
    try { await loadUsers(ownerToken, query); return true }
    catch (error) {
      if ((error as { unauthorized?: boolean }).unauthorized) signOut('owner token ไม่ถูกต้องหรือหมดอายุ')
      else setNotice(error instanceof Error ? error.message : 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ')
      return false
    } finally { setBusy(false) }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY) || ''
    if (!saved) { setChecking(false); return }
    setToken(saved)
    void run('', saved).then(ok => { setAuthed(ok); setChecking(false) })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function connectOwner(event: FormEvent) {
    event.preventDefault()
    if (await run('', token)) { sessionStorage.setItem(TOKEN_KEY, token); setAuthed(true) }
  }

  return <main className="shell">
    <header className="header"><div><p className="eyebrow">OWNER ONLY</p><h1>ฐานข้อมูลผู้ใช้</h1></div>{authed && <button onClick={() => signOut()}>ออกจากระบบ</button>}</header>
    {notice && <div className="notice" role="status">{notice}</div>}

    {!checking && !authed && <form className="card owner-card" onSubmit={connectOwner}><h2>ยืนยันสิทธิ์เจ้าของ</h2><p>ใส่ token จากไฟล์ local <code>owner-token.txt</code> บนเครื่องที่รันบอท</p><div className="inline-form"><input aria-label="Owner token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} placeholder="Owner token" /><button className="primary" disabled={busy || !token}>ยืนยัน</button></div></form>}

    {authed && <section className="card"><div className="section-heading"><div><p className="eyebrow">USER DIRECTORY</p><h2>ผู้ใช้ทั้งหมด</h2></div><span className="badge">{usersCount} UUID</span></div><p className="muted">เก็บอัตโนมัติทุกครั้งที่บอทเห็นชื่อ (เจ้าของห้อง · คนในห้อง · คนเข้า/ออก) — เก็บชื่อปัจจุบันและชื่อที่เคยใช้ ต่อ 1 UUID</p><form className="inline-form" onSubmit={event => { event.preventDefault(); void run(usersQuery) }}><input aria-label="ค้นหาผู้ใช้" value={usersQuery} onChange={event => setUsersQuery(event.target.value)} placeholder="ค้นหาชื่อ / ชื่อเก่า / UUID" disabled={busy} /><button className="primary" disabled={busy}>ค้นหา</button><button type="button" onClick={() => { setUsersQuery(''); void run('') }} disabled={busy}>ล้าง</button></form>{users.length > 0 ? <div className="room-list">{users.map(user => <div className="room-row" key={user.uuid}><div><strong>{user.name || '(ไม่มีชื่อ)'}</strong><span className="muted">{user.uuid}</span>{user.previousNames.length ? <span className="member-chips">{user.previousNames.map((name, index) => <span className="member-chip" key={index}>{name}</span>)}</span> : null}</div></div>)}</div> : <p className="muted">ยังไม่มีข้อมูล — ให้บอทโหลดห้อง/เข้าห้องก่อน เพื่อเริ่มเก็บชื่อ</p>}</section>}
  </main>
}
