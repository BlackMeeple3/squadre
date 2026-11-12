import { useState, useEffect, useRef, useMemo } from 'react'
import {
  DndContext, DragOverlay,
  PointerSensor, TouchSensor,
  useSensor, useSensors,
  useDroppable, useDraggable,
} from '@dnd-kit/core'
import {
  collection, addDoc, updateDoc, deleteDoc, setDoc, writeBatch,
  doc, onSnapshot, orderBy, query, serverTimestamp,
} from 'firebase/firestore'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { db, auth, googleProvider, ADMIN_EMAIL } from './lib/firebase'
import './index.css'

// ── Utils ──────────────────────────────────────────────
function initials(name) {
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase()
}

function resizeImage(file, maxSize = 400, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > height) {
        if (width > maxSize) { height = Math.round(height * maxSize / width); width = maxSize }
      } else {
        if (height > maxSize) { width = Math.round(width * maxSize / height); height = maxSize }
      }
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d').drawImage(img, 0, 0, width, height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = reject
    img.src = url
  })
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00')
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
}

// Data di oggi nel fuso del telefono (toISOString userebbe UTC e dopo mezzanotte darebbe il giorno prima)
function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ── Avatar ─────────────────────────────────────────────
function Avatar({ participant, size = 64 }) {
  return (
    <div className="avatar" style={{ width: size, height: size }}>
      {participant.photo_url
        ? <img src={participant.photo_url} alt={participant.name} />
        : <div className="avatar-initials" style={{ fontSize: size * 0.3 }}>{initials(participant.name)}</div>
      }
    </div>
  )
}

// ── Draggable card ─────────────────────────────────────
function ParticipantCard({ participant, inTeam, onHide, onEdit, showActions }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: participant.id })
  const sz = inTeam ? 40 : 60

  return (
    <div ref={setNodeRef} className={`participant ${isDragging ? 'dragging' : ''}`} {...listeners} {...attributes}>
      <Avatar participant={participant} size={sz} />
      {!inTeam && <span className="participant-name">{participant.name}</span>}
      {inTeam && <span className="participant-name">{participant.name}</span>}

      {showActions && !inTeam && (
        <div className="pool-card-actions">
          <button className="del-btn edit-btn" onPointerDown={e => { e.stopPropagation(); onEdit(participant) }}>✎</button>
          <button className="del-btn hide-btn" onPointerDown={e => { e.stopPropagation(); onHide(participant.id) }}>👁</button>
        </div>
      )}
      {showActions && inTeam && (
        <div className="card-actions">
          <button className="del-btn edit-btn" onPointerDown={e => { e.stopPropagation(); onEdit(participant) }}>✎</button>
          <button className="del-btn hide-btn" onPointerDown={e => { e.stopPropagation(); onHide(participant.id) }}>👁</button>
        </div>
      )}
    </div>
  )
}

// ── Droppable zones ────────────────────────────────────
function DroppablePool({ children }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })
  return (
    <div ref={setNodeRef} className={`pool-scroll ${isOver ? 'drag-over' : ''}`}>
      {children}
      {children.length === 0 && <div className="empty-drop"><span>Nessuno in attesa</span></div>}
    </div>
  )
}

function DroppableTeam({ team, members, count, showActions, onHide, onEdit, onWin }) {
  const { setNodeRef, isOver } = useDroppable({ id: team })
  return (
    <div ref={setNodeRef} className={`team-col ${team} ${isOver ? 'drag-over' : ''}`}>
      <span className="team-count">{count}</span>
      <div className="team-members">
        {members.length === 0
          ? <div className="empty-drop"><span>Trascina qui</span></div>
          : members.map(p => (
            <ParticipantCard
              key={p.id} participant={p} inTeam
              showActions={showActions} onHide={onHide} onEdit={onEdit}
            />
          ))
        }
      </div>
      {members.length > 0 && (
        <button className="win-btn" onClick={() => onWin(team)}>
          🏆 Ha vinto!
        </button>
      )}
    </div>
  )
}

// ── Participant Modal (add/edit) ────────────────────────
function ParticipantModal({ existing, onClose, onSave }) {
  const [name, setName] = useState(existing?.name || '')
  const [photoPreview, setPhotoPreview] = useState(existing?.photo_url || null)
  const [photoBase64, setPhotoBase64] = useState(null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef()
  const isEdit = !!existing

  const handlePhoto = async e => {
    const file = e.target.files[0]
    if (!file) return
    setUploading(true)
    try {
      const b64 = await resizeImage(file)
      setPhotoBase64(b64); setPhotoPreview(b64)
    } finally { setUploading(false) }
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setUploading(true)
    try {
      const photo_url = photoBase64 || existing?.photo_url || null
      if (isEdit) {
        await updateDoc(doc(db, 'participants', existing.id), { name: name.trim(), photo_url })
        onSave({ ...existing, name: name.trim(), photo_url })
      } else {
        const ref = await addDoc(collection(db, 'participants'), {
          name: name.trim(), photo_url, team: 'pool',
          position: Date.now(), hidden: false,
          wins: 0, matches: 0,
          created_at: serverTimestamp(),
        })
        onSave({ id: ref.id, name: name.trim(), photo_url, team: 'pool', hidden: false, wins: 0, matches: 0 })
      }
    } finally { setUploading(false) }
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{isEdit ? 'Modifica' : 'Nuovo partecipante'}</h2>
        <div className="photo-picker" onClick={() => fileRef.current.click()}>
          {photoPreview ? <img src={photoPreview} alt="preview" /> : <>
            <span className="photo-icon">📷</span>
            <span className="photo-picker-label">Aggiungi foto</span>
          </>}
          {uploading && <div className="uploading-indicator"><div className="spinner" /></div>}
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handlePhoto} />
        <div className="field">
          <label>Nome</label>
          <input type="text" placeholder="Es. Marco Rossi" value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()} autoFocus />
        </div>
        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button className="btn-save" onClick={handleSave} disabled={!name.trim() || uploading}>
            {uploading ? 'Salvataggio…' : isEdit ? 'Salva' : 'Aggiungi'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Win Confirm Modal ──────────────────────────────────
function WinModal({ team, teamA, teamB, matches, onClose, onConfirm }) {
  const [date, setDate] = useState(todayISO())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const isDraw = team === 'draw'
  const members = isDraw ? [...teamA, ...teamB] : (team === 'a' ? teamA : teamB)
  const existing = date ? matches.find(m => m.date === date) : null

  const handle = async () => {
    setSaving(true)
    setError('')
    try {
      await onConfirm(team, members, date)
    } catch (e) {
      setError(e.message === 'duplicate'
        ? 'Per questo giorno c’è già un risultato.'
        : 'Salvataggio non riuscito, riprova.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{isDraw ? '🤝 Pareggio!' : `🏆 Squadra ${team.toUpperCase()} vince!`}</h2>
        <p>{isDraw ? 'Tutti prendono +1 presenza, nessuna vittoria.' : 'Ogni giocatore della squadra vincente riceve un punto.'}</p>

        <div className="win-team-preview">
          {members.map(p => (
            <div className="mini-player" key={p.id}>
              <Avatar participant={p} size={44} />
              <span>{p.name.split(' ')[0]}</span>
            </div>
          ))}
        </div>

        <div className="date-row">
          <label>Data</label>
          <input className="date-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {existing && (
          <p className="warn-note">
            Il {formatDate(date)} c’è già {existing.isDraw ? 'un pareggio' : `una vittoria (squadra ${existing.winnerTeam.toUpperCase()})`}.
            Si registra un solo risultato al giorno: scegli un’altra data oppure fallo correggere all’admin dallo Storico.
          </p>
        )}
        {error && <p className="warn-note">{error}</p>}

        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button
            className={`btn-save ${isDraw ? '' : team === 'a' ? 'btn-win-a' : 'btn-win-b'}`}
            onClick={handle} disabled={saving || !date || !!existing}
          >
            {saving ? 'Salvataggio…' : isDraw ? 'Conferma pareggio' : 'Conferma vittoria'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Stats helpers ──────────────────────────────────────
// Colori fissi per giocatore nel grafico (stessa palette validata, versione scura)
const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767']

function shortDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
}

function matchKey(m) {
  return `${m.date}|${String(m.created_at?.seconds || 0).padStart(12, '0')}`
}

// Porta ogni partita (vecchia o nuova) a una forma unica.
// split = [lato1, lato2] (per le vittorie lato1 = vincitori), oppure null se non si sa come erano divise le squadre
function normalizeMatch(m) {
  const all = m.allIds || []
  if (m.isDraw) {
    const split = m.teamA && m.teamB ? [m.teamA, m.teamB] : null
    return { ...m, kind: 'draw', all, winners: [], losers: [], split }
  }
  const winners = m.winnerIds || []
  const losers = all.filter(id => !winners.includes(id))
  return { ...m, kind: 'win', all, winners, losers, split: [winners, losers] }
}

function computeStats(participants, matches) {
  const ordered = [...matches]
    .sort((a, b) => (matchKey(a) < matchKey(b) ? -1 : 1))
    .map(normalizeMatch)

  const stats = {}
  participants.forEach(p => {
    stats[p.id] = { id: p.id, wins: 0, losses: 0, draws: 0, played: 0, streak: 0, best: 0, series: [0], results: [], first: null, last: null }
  })

  ordered.forEach(m => {
    Object.values(stats).forEach(s => {
      if (m.all.includes(s.id)) {
        s.played++
        if (!s.first) s.first = m.date
        s.last = m.date
        if (m.kind === 'draw') {
          s.draws++
          s.streak = 0
          s.results.push('D')
        } else if (m.winners.includes(s.id)) {
          s.wins++
          s.streak++
          s.best = Math.max(s.best, s.streak)
          s.results.push('W')
        } else {
          s.losses++
          s.streak = 0
          s.results.push('L')
        }
      }
      s.series.push(s.wins)
    })
  })

  return { ordered, stats }
}

// La % vittorie ha senso solo con un minimo di partite: sotto la soglia vale null (non contata)
const MIN_PCT_GAMES = 3
function winPct(s) {
  return s.played >= MIN_PCT_GAMES ? s.wins / s.played : null
}

function headToHead(ordered, a, b) {
  const r = {
    together: { n: 0, w: 0, l: 0, d: 0 },
    against: { n: 0, aWins: 0, bWins: 0, d: 0 },
    unknownDraws: 0,
  }
  ordered.forEach(m => {
    if (!m.all.includes(a) || !m.all.includes(b)) return
    if (!m.split) { r.unknownDraws++; return }
    const [first] = m.split
    const aSide = first.includes(a) ? 0 : 1
    const bSide = first.includes(b) ? 0 : 1
    if (aSide === bSide) {
      r.together.n++
      if (m.kind === 'draw') r.together.d++
      else if (aSide === 0) r.together.w++
      else r.together.l++
    } else {
      r.against.n++
      if (m.kind === 'draw') r.against.d++
      else if (aSide === 0) r.against.aWins++
      else r.against.bWins++
    }
  })
  return r
}

// Per ogni giocatore: l'avversario contro cui ha perso più volte
function computeNemesis(ordered, participants) {
  const lost = {}
  const met = {}
  const inc = (o, p, q) => {
    if (!o[p]) o[p] = {}
    o[p][q] = (o[p][q] || 0) + 1
  }
  ordered.forEach(m => {
    if (!m.split) return
    const [x, y] = m.split
    x.forEach(p => y.forEach(q => {
      inc(met, p, q)
      inc(met, q, p)
      if (m.kind === 'win') inc(lost, q, p) // q (perdente) ha perso contro p (vincitore)
    }))
  })

  const result = {}
  participants.forEach(p => {
    const row = lost[p.id] || {}
    let best = null
    Object.keys(row).forEach(qid => {
      const cand = { id: qid, lost: row[qid], met: (met[p.id] || {})[qid] || 0 }
      if (!best || cand.lost > best.lost || (cand.lost === best.lost && cand.met > best.met)) best = cand
    })
    result[p.id] = best
  })
  return result
}

// Compagni e avversari di un singolo giocatore.
// Nemesi e vittima: chi ti ha battuto / chi hai battuto più volte da avversario (a parità, più scontri).
// Miglior compagno: % di vittorie in squadra insieme, contata solo da MIN_PCT_GAMES partite insieme.
function computeRelations(ordered, pid) {
  const rel = {}
  const get = id => {
    if (!rel[id]) rel[id] = { id, tn: 0, tw: 0, td: 0, tl: 0, an: 0, aw: 0, ad: 0, al: 0 }
    return rel[id]
  }
  ordered.forEach(m => {
    if (!m.split || !m.all.includes(pid)) return
    const first = m.split[0]
    const mySide = first.includes(pid) ? 0 : 1
    m.all.forEach(oid => {
      if (oid === pid) return
      const r = get(oid)
      const otherSide = first.includes(oid) ? 0 : 1
      if (otherSide === mySide) {
        r.tn++
        if (m.kind === 'draw') r.td++
        else if (mySide === 0) r.tw++
        else r.tl++
      } else {
        r.an++
        if (m.kind === 'draw') r.ad++
        else if (mySide === 0) r.aw++
        else r.al++
      }
    })
  })

  const list = Object.values(rel)
  const pickMax = (rows, key) => rows.reduce((best, r) => (
    !best || r[key] > best[key] || (r[key] === best[key] && r.an > best.an) ? r : best
  ), null)
  const nemesis = pickMax(list.filter(r => r.al > 0), 'al')
  const victim = pickMax(list.filter(r => r.aw > 0), 'aw')
  const mate = list
    .filter(r => r.tn >= MIN_PCT_GAMES)
    .reduce((best, r) => (
      !best || r.tw / r.tn > best.tw / best.tn || (r.tw / r.tn === best.tw / best.tn && r.tn > best.tn) ? r : best
    ), null)
  return { nemesis, victim, mate }
}

// ── Stagioni, correzione risultati, squadre (logica pura) ─
// Stagione dal 1° settembre al 31 agosto, etichetta "2026/27"
const SEASON_START_MONTH = 9
function seasonOf(iso) {
  const y = +iso.slice(0, 4)
  const mo = +iso.slice(5, 7)
  const start = mo >= SEASON_START_MONTH ? y : y - 1
  return `${start}/${String(start + 1).slice(2)}`
}

// Campi aggiunti da normalizeMatch: non vanno mai riscritti su Firestore
function stripNormalized(m) {
  const { id, kind, all, winners, losers, split, ...raw } = m
  return raw
}

// [squadra A, squadra B] di una partita, oppure null se non si sa come erano divise
function matchSides(m) {
  if (m.kind === 'win') {
    return m.winnerTeam === 'a' ? [m.winners, m.losers] : [m.losers, m.winners]
  }
  return m.teamA && m.teamB ? [m.teamA, m.teamB] : null
}

// Campi da salvare per portare la partita a 'a' | 'b' | 'draw'. null se non si può (pareggio senza squadre → vittoria)
function resultFields(m, result) {
  const sides = matchSides(m)
  if (!sides) return result === 'draw' ? { winnerTeam: 'draw', isDraw: true, winnerIds: [] } : null
  const [A, B] = sides
  return {
    winnerTeam: result,
    isDraw: result === 'draw',
    winnerIds: result === 'a' ? A : result === 'b' ? B : [],
    teamA: A,
    teamB: B,
  }
}

// Precompilazione: i più presenti (stagione corrente se ha almeno 3 partite, altrimenti tutto lo storico),
// a parità presenze di sempre, poi vittorie. "Fissi" = presenti ad almeno il 60% delle partite.
const REGULAR_RATE = 0.6
function buildLineup(candidates, matches, season) {
  const inSeason = matches.filter(m => seasonOf(m.date) === season)
  const base = inSeason.length >= 3 ? inSeason : matches
  const { stats } = computeStats(candidates, base)
  const all = computeStats(candidates, matches).stats
  const ranked = [...candidates].sort((a, b) =>
    (stats[b.id].played - stats[a.id].played) ||
    (all[b.id].played - all[a.id].played) ||
    (stats[b.id].wins - stats[a.id].wins) ||
    a.name.localeCompare(b.name))
  const days = base.length
  const regulars = days ? ranked.filter(p => stats[p.id].played / days >= REGULAR_RATE).length : ranked.length
  const defaultCount = Math.min(ranked.length, Math.max(4, regulars))
  return { ranked, stats, days, defaultCount }
}

// Divide in due squadre bilanciate (a "serpentina" sulla % vittorie): con numero dispari
// la squadra più debole ha un giocatore in più. Sotto le 3 partite la % non conta: forza neutra.
function splitBalanced(selected, stats) {
  const strength = p => winPct(stats[p.id]) ?? 0.5
  const order = [...selected].sort((a, b) =>
    (strength(b) - strength(a)) || (stats[b.id].wins - stats[a.id].wins) || a.name.localeCompare(b.name))
  const A = [], B = []
  order.forEach((p, i) => ((i % 4 === 0 || i % 4 === 3) ? A : B).push(p))
  return { A, B }
}

const METRICS = [
  { key: 'wins', label: 'Vittorie', val: s => s.wins, fmt: v => v, unit: 'V' },
  { key: 'played', label: 'Presenze', val: s => s.played, fmt: v => v, unit: 'P' },
  { key: 'pct', label: '% vittorie', val: s => winPct(s) ?? -1, fmt: v => (v < 0 ? '—' : `${Math.round(v * 100)}%`), unit: '' },
  { key: 'streak', label: 'Striscia', val: s => s.streak, fmt: v => v, unit: '🔥' },
  { key: 'best', label: 'Record striscia', val: s => s.best, fmt: v => v, unit: '🔥' },
  { key: 'draws', label: 'Pareggi', val: s => s.draws, fmt: v => v, unit: '' },
  { key: 'losses', label: 'Sconfitte', val: s => s.losses, fmt: v => v, unit: '' },
]

// ── Stats: pieces ──────────────────────────────────────
function PlayerGrid({ players, marks, onPick }) {
  return (
    <div className="pick-grid">
      {players.map(p => (
        <button key={p.id} className="pick-item" onClick={() => onPick(p.id)}>
          <div className="pick-ring" style={{ borderColor: marks[p.id] || 'transparent' }}>
            <Avatar participant={p} size={44} />
          </div>
          <span>{p.name.split(' ')[0]}</span>
        </button>
      ))}
    </div>
  )
}

function ProgressChart({ players, stats, ordered, cmpWins }) {
  const [sel, setSel] = useState(null) // { playerId: slotColore }
  const [hover, setHover] = useState(null)
  const svgRef = useRef(null)

  const N = ordered.length
  const ranked = [...players].sort(cmpWins)
  const active = sel || Object.fromEntries(ranked.slice(0, 5).map((p, i) => [p.id, i]))
  const activeIds = Object.keys(active).filter(id => stats[id])
  const byId = Object.fromEntries(players.map(p => [p.id, p]))

  function toggle(id) {
    const cur = { ...active }
    if (id in cur) {
      delete cur[id]
    } else {
      const used = new Set(Object.values(cur))
      const free = SERIES.findIndex((_, i) => !used.has(i))
      if (free === -1) return
      cur[id] = free
    }
    setSel(cur)
  }

  const W = 360, H = 230, L = 30, R = 14, T = 14, B = 26
  const maxV = Math.max(1, ...activeIds.map(id => stats[id].series[N]))
  const step = Math.max(1, Math.ceil(maxV / 4))
  const yMax = Math.ceil(maxV / step) * step
  const ticks = []
  for (let v = 0; v <= yMax; v += step) ticks.push(v)
  const x = i => L + ((W - L - R) * i) / N
  const y = v => T + ((H - T - B) * (1 - v / yMax))

  function onMove(e) {
    const rect = svgRef.current.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W
    const i = Math.max(0, Math.min(N, Math.round(((px - L) / (W - L - R)) * N)))
    setHover(i)
  }

  const at = hover ?? N
  const tipRows = hover === null ? [] : activeIds
    .map(id => ({ id, p: byId[id], v: stats[id].series[hover], color: SERIES[active[id]] }))
    .filter(r => r.p)
    .sort((a, b) => b.v - a.v)
  const xPct = (x(hover ?? 0) / W) * 100

  return (
    <div className="chart-card">
      <p className="chart-title">Vittorie accumulate partita dopo partita</p>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Andamento delle vittorie nel tempo"
          style={{ touchAction: 'pan-y', display: 'block' }}
          onPointerDown={onMove}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map(v => (
            <g key={v}>
              <line className="chart-grid" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
              <text className="chart-axis" x={L - 6} y={y(v) + 3} textAnchor="end">{v}</text>
            </g>
          ))}
          <text className="chart-axis" x={L} y={H - 8} textAnchor="start">{shortDate(ordered[0].date)}</text>
          <text className="chart-axis" x={W - R} y={H - 8} textAnchor="end">{shortDate(ordered[N - 1].date)}</text>

          {hover !== null && <line className="chart-cross" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />}

          {activeIds.map(id => {
            const d = stats[id].series
              .map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
              .join(' ')
            return (
              <path key={id} d={d} fill="none" stroke={SERIES[active[id]]}
                strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            )
          })}
          {activeIds.map(id => (
            <circle key={id} className="chart-dot" cx={x(at)} cy={y(stats[id].series[at])} r="4" fill={SERIES[active[id]]} />
          ))}
        </svg>

        {hover !== null && (
          <div
            className="chart-tip"
            style={{
              left: `${xPct}%`,
              transform: xPct > 55 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div className="chart-tip-head">
              {hover === 0 ? 'Inizio' : `Partita ${hover} · ${shortDate(ordered[hover - 1].date)}`}
            </div>
            {tipRows.map(r => (
              <div key={r.id} className="chart-tip-row">
                <span className="chart-tip-key" style={{ background: r.color }} />
                <strong>{r.v}</strong>
                <span>{r.p.name.split(' ')[0]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="chart-legend">
        {ranked.map(p => {
          const on = p.id in active
          return (
            <button key={p.id} className={`chip chip-player ${on ? 'on' : ''}`} onClick={() => toggle(p.id)}>
              <span className="chip-key" style={on ? { background: SERIES[active[p.id]] } : undefined} />
              <Avatar participant={p} size={22} />
              <span>{p.name.split(' ')[0]}</span>
              {on && <b>{stats[p.id].wins}</b>}
            </button>
          )
        })}
      </div>
      {activeIds.length >= SERIES.length && <p className="chart-note">Massimo {SERIES.length} giocatori insieme.</p>}
    </div>
  )
}

function HeadToHead({ players, ordered }) {
  const [pair, setPair] = useState([])
  const pick = id => setPair(cur =>
    cur.includes(id) ? cur.filter(x => x !== id) : cur.length < 2 ? [...cur, id] : [cur[1], id]
  )
  const [aId, bId] = pair
  const pa = players.find(p => p.id === aId)
  const pb = players.find(p => p.id === bId)
  const marks = {}
  if (aId) marks[aId] = SERIES[0]
  if (bId) marks[bId] = SERIES[1]
  const r = pa && pb ? headToHead(ordered, aId, bId) : null
  const an = pa?.name.split(' ')[0]
  const bn = pb?.name.split(' ')[0]

  return (
    <div>
      <p className="hint">Tocca due giocatori per vedere il loro confronto.</p>
      <PlayerGrid players={players} marks={marks} onPick={pick} />

      {r && (
        <div className="h2h">
          <div className="h2h-head">
            <div className="h2h-side">
              <div className="pick-ring" style={{ borderColor: SERIES[0] }}><Avatar participant={pa} size={56} /></div>
              <span>{an}</span>
            </div>
            <span className="h2h-vs">VS</span>
            <div className="h2h-side">
              <div className="pick-ring" style={{ borderColor: SERIES[1] }}><Avatar participant={pb} size={56} /></div>
              <span>{bn}</span>
            </div>
          </div>

          <div className="h2h-card">
            <div className="h2h-card-title">Uno contro l'altro</div>
            {r.against.n === 0 ? (
              <div className="h2h-empty">Non si sono mai affrontati</div>
            ) : (
              <>
                <div className="h2h-nums">
                  <div><strong>{r.against.aWins}</strong><span>{an} vince</span></div>
                  <div><strong>{r.against.d}</strong><span>pari</span></div>
                  <div><strong>{r.against.bWins}</strong><span>{bn} vince</span></div>
                </div>
                <div className="h2h-bar">
                  {r.against.aWins > 0 && <i style={{ flex: r.against.aWins, background: SERIES[0] }} />}
                  {r.against.d > 0 && <i style={{ flex: r.against.d, background: 'var(--text-muted)' }} />}
                  {r.against.bWins > 0 && <i style={{ flex: r.against.bWins, background: SERIES[1] }} />}
                </div>
                <div className="h2h-total">{r.against.n} {r.against.n === 1 ? 'scontro' : 'scontri'}</div>
              </>
            )}
          </div>

          <div className="h2h-card">
            <div className="h2h-card-title">Nella stessa squadra</div>
            {r.together.n === 0 ? (
              <div className="h2h-empty">Non hanno mai giocato insieme</div>
            ) : (
              <>
                <div className="h2h-nums">
                  <div><strong>{r.together.w}</strong><span>vinte</span></div>
                  <div><strong>{r.together.d}</strong><span>pari</span></div>
                  <div><strong>{r.together.l}</strong><span>perse</span></div>
                </div>
                <div className="h2h-total">{r.together.n} {r.together.n === 1 ? 'partita' : 'partite'} insieme</div>
              </>
            )}
          </div>

          {r.unknownDraws > 0 && (
            <p className="chart-note">
              {r.unknownDraws} {r.unknownDraws === 1 ? 'pareggio' : 'pareggi'} registrati prima di questo aggiornamento
              non hanno le squadre salvate e non sono contati.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

const FORM_LABEL = { W: 'V', D: 'P', L: 'S' }
const FORM_TITLE = { W: 'Vittoria', D: 'Pareggio', L: 'Sconfitta' }

function RelRow({ title, other, text, empty }) {
  return (
    <div className="rel-row">
      {other ? <Avatar participant={other} size={36} /> : <div className="rel-ph" />}
      <div className="lb-main">
        <span className="rel-title">{title}</span>
        <span className="lb-name">{other ? other.name : '—'}</span>
        <span className="lb-sub">{other ? text : empty}</span>
      </div>
    </div>
  )
}

function PlayerSheet({ player, s, rankPos, ordered, byId, onClose }) {
  const rel = useMemo(() => computeRelations(ordered, player.id), [ordered, player.id])
  const pct = winPct(s)
  const form = s.results.slice(-5)

  useEffect(() => {
    const onKey = e => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const times = n => `${n} ${n === 1 ? 'volta' : 'volte'}`
  const nem = rel.nemesis, vic = rel.victim, mate = rel.mate

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal sheet" role="dialog" aria-label={`Statistiche di ${player.name}`}>
        <div className="sheet-head">
          <Avatar participant={player} size={72} />
          <div className="sheet-title">
            <h2>{player.name}</h2>
            <span>{rankPos}° per vittorie · {s.played} {s.played === 1 ? 'partita' : 'partite'}</span>
          </div>
          <button className="sheet-close" onClick={onClose} aria-label="Chiudi">×</button>
        </div>

        <div className="sheet-grid">
          <div className="sheet-tile"><strong>{s.wins}</strong><span>vinte</span></div>
          <div className="sheet-tile"><strong>{s.draws}</strong><span>pari</span></div>
          <div className="sheet-tile"><strong>{s.losses}</strong><span>perse</span></div>
          <div className="sheet-tile">
            <strong>{pct === null ? '—' : `${Math.round(pct * 100)}%`}</strong>
            <span>{pct === null ? `servono ${MIN_PCT_GAMES} partite` : 'vittorie'}</span>
          </div>
          <div className="sheet-tile"><strong>{s.streak}</strong><span>striscia 🔥</span></div>
          <div className="sheet-tile"><strong>{s.best}</strong><span>record 🔥</span></div>
        </div>

        <div className="sheet-label">Ultime partite{form.length > 0 ? ' (la più recente a destra)' : ''}</div>
        <div className="form-row">
          {form.map((r, i) => (
            <span key={i} className={`form-dot ${r}`} title={FORM_TITLE[r]} aria-label={FORM_TITLE[r]}>{FORM_LABEL[r]}</span>
          ))}
        </div>

        <div className="sheet-label">Con gli altri</div>
        <RelRow
          title="Miglior compagno" other={mate && byId[mate.id]}
          text={mate ? `${mate.tw} vinte su ${mate.tn} insieme` : ''}
          empty={`Servono ${MIN_PCT_GAMES} partite in squadra con lo stesso giocatore`}
        />
        <RelRow
          title="Nemesi" other={nem && byId[nem.id]}
          text={nem ? `Ha perso contro di lui ${times(nem.al)} su ${nem.an}` : ''}
          empty="Nessuna: non ha mai perso da avversario"
        />
        <RelRow
          title="Vittima preferita" other={vic && byId[vic.id]}
          text={vic ? `L'ha battuto ${times(vic.aw)} su ${vic.an}` : ''}
          empty="Nessuno battuto da avversario finora"
        />

        {s.first && (
          <p className="chart-note">In campo dal {formatDate(s.first)} · ultima partita {formatDate(s.last)}</p>
        )}
      </div>
    </div>
  )
}

function NemesisList({ players, stats, ordered, cmpWins, tap }) {
  const nem = useMemo(() => computeNemesis(ordered, players), [ordered, players])
  const byId = Object.fromEntries(players.map(p => [p.id, p]))
  const rows = [...players].sort((a, b) => ((nem[b.id]?.lost || 0) - (nem[a.id]?.lost || 0)) || cmpWins(a, b))

  return (
    <div className="leaderboard">
      <p className="hint">L'avversario contro cui hai perso più volte.</p>
      {rows.map(p => {
        const n = nem[p.id]
        const q = n ? byId[n.id] : null
        return (
          <div key={p.id} className="lb-row tappable" {...tap(p.id)}>
            <Avatar participant={p} size={36} />
            <div className="lb-main">
              <span className="lb-name">{p.name}</span>
              <span className="lb-sub">
                {q ? `${n.lost} ${n.lost === 1 ? 'sconfitta' : 'sconfitte'} su ${n.met} scontri` : 'Nessuna nemesi 😎'}
              </span>
            </div>
            {q && (
              <div className="nem-target">
                <Avatar participant={q} size={36} />
                <span>{q.name.split(' ')[0]}</span>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Modifica partita (solo admin) ──────────────────────
const RESULT_LABEL = { a: 'Squadra A', draw: 'Pareggio', b: 'Squadra B' }

function MatchEditModal({ match, matches, onClose }) {
  const current = match.kind === 'draw' ? 'draw' : match.winnerTeam
  const sides = matchSides(match)
  const [result, setResult] = useState(current)
  const [date, setDate] = useState(match.date)
  const [saving, setSaving] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [error, setError] = useState('')
  const other = date ? matches.find(x => x.id !== match.id && x.date === date) : null
  const unchanged = result === current && date === match.date

  const fail = e => setError(e && e.code === 'permission-denied'
    ? 'Permesso negato: controlla di aver fatto l’accesso con l’account admin e che le regole di Firestore siano aggiornate.'
    : 'Operazione non riuscita, riprova.')

  async function save() {
    const fields = resultFields(match, result)
    if (!fields || !date) return
    setSaving(true)
    setError('')
    try {
      if (date === match.date) {
        await updateDoc(doc(db, 'matches', match.id), fields)
      } else {
        // la partita è identificata dalla data: cambiare giorno = nuovo documento + eliminazione del vecchio
        const batch = writeBatch(db)
        batch.set(doc(db, 'matches', date), { ...stripNormalized(match), ...fields, date })
        batch.delete(doc(db, 'matches', match.id))
        await batch.commit()
      }
      onClose()
    } catch (e) {
      fail(e)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setSaving(true)
    setError('')
    try {
      await deleteDoc(doc(db, 'matches', match.id))
      onClose()
    } catch (e) {
      fail(e)
      setConfirmDel(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>Modifica partita</h2>

        <div className="field">
          <label>Risultato</label>
          <div className="seg">
            {['a', 'draw', 'b'].map(r => (
              <button
                key={r}
                className={`seg-btn ${r} ${result === r ? 'on' : ''}`}
                disabled={!sides && r !== current}
                onClick={() => setResult(r)}
              >{RESULT_LABEL[r]}</button>
            ))}
          </div>
        </div>
        {!sides && (
          <p className="warn-note">Di questo pareggio non erano state salvate le squadre: non si può trasformare in vittoria.</p>
        )}

        <div className="date-row">
          <label>Data</label>
          <input className="date-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        {other && <p className="warn-note">Il {formatDate(date)} c’è già un altro risultato: una sola partita al giorno.</p>}
        {error && <p className="warn-note">{error}</p>}

        <div className="modal-actions">
          <button className={`btn-del ${confirmDel ? 'sure' : ''}`} disabled={saving}
            onClick={() => (confirmDel ? remove() : setConfirmDel(true))}>
            {confirmDel ? 'Sicuro?' : 'Elimina'}
          </button>
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button className="btn-save" onClick={save} disabled={saving || unchanged || !!other || !date}>
            {saving ? '…' : 'Salva'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Precompila squadre ─────────────────────────────────
function LineupSheet({ lineup, season, onApply, onClose }) {
  const { ranked, stats, days, defaultCount } = lineup
  const [n, setN] = useState(defaultCount)
  const { A, B } = useMemo(() => splitBalanced(ranked.slice(0, n), stats), [n, ranked, stats])
  const rest = ranked.slice(n)

  const col = (team, list) => (
    <div className={`lineup-col ${team}`}>
      <div className="lineup-head">Squadra {team.toUpperCase()} <b>{list.length}</b></div>
      {list.map(p => (
        <div key={p.id} className="lineup-row">
          <Avatar participant={p} size={30} />
          <span className="lineup-name">{p.name.split(' ')[0]}</span>
          {days > 0 && <span className="lineup-pres">{stats[p.id].played}/{days}</span>}
        </div>
      ))}
    </div>
  )

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal sheet" role="dialog" aria-label="Precompila squadre">
        <h2>✨ Precompila squadre</h2>
        <p>
          {days > 0
            ? `Metto i più presenti (stagione ${season}, ${days} ${days === 1 ? 'partita' : 'partite'}) e li divido in modo bilanciato. Gli altri restano in attesa.`
            : 'Ancora nessuna partita registrata: divido tutti i presenti. Gli altri restano in attesa.'}
        </p>

        <div className="stepper">
          <button onClick={() => setN(v => Math.max(2, v - 1))} disabled={n <= 2} aria-label="Meno giocatori">−</button>
          <div><strong>{n}</strong><span>giocatori in squadra</span></div>
          <button onClick={() => setN(v => Math.min(ranked.length, v + 1))} disabled={n >= ranked.length} aria-label="Più giocatori">+</button>
        </div>

        <div className="lineup-grid">
          {col('a', A)}
          {col('b', B)}
        </div>

        {rest.length > 0 && (
          <p className="lineup-rest">In attesa: {rest.map(p => p.name.split(' ')[0]).join(', ')}</p>
        )}

        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button className="btn-save" onClick={() => onApply(A, B)}>Applica</button>
        </div>
      </div>
    </div>
  )
}

// ── Accesso admin ──────────────────────────────────────
function AccountButton({ user, isAdmin, onSignIn, onSignOut }) {
  if (!user) return <button className="acct-btn" onClick={onSignIn}>🔒 Accedi</button>
  return (
    <button className={`acct-btn ${isAdmin ? 'ok' : 'warn'}`} onClick={onSignOut}>
      {isAdmin ? '✓ Admin · Esci' : 'Non autorizzato · Esci'}
    </button>
  )
}

// ── Stats Page ─────────────────────────────────────────
function StatsPage({ participants, matches: allMatches, isAdmin }) {
  const currentSeason = useMemo(() => seasonOf(todayISO()), [])
  const [season, setSeason] = useState(currentSeason) // 'YYYY/YY' oppure 'all'
  const [tab, setTab] = useState('rank')
  const [metric, setMetric] = useState('wins')
  const [openId, setOpenId] = useState(null)
  const [editing, setEditing] = useState(null)

  const seasons = useMemo(() => {
    const set = new Set(allMatches.map(m => seasonOf(m.date)))
    set.add(currentSeason)
    return [...set].sort().reverse()
  }, [allMatches, currentSeason])
  const matches = useMemo(
    () => (season === 'all' ? allMatches : allMatches.filter(m => seasonOf(m.date) === season)),
    [allMatches, season]
  )

  const { ordered, stats } = useMemo(() => computeStats(participants, matches), [participants, matches])
  const players = useMemo(() => participants.filter(p => stats[p.id]?.played > 0), [participants, stats])
  const byId = useMemo(() => Object.fromEntries(participants.map(p => [p.id, p])), [participants])

  const cmpWins = (a, b) => {
    const sa = stats[a.id], sb = stats[b.id]
    return (sb.wins - sa.wins) || ((winPct(sb) ?? -1) - (winPct(sa) ?? -1)) || (sb.played - sa.played)
  }

  const tap = id => ({
    role: 'button',
    tabIndex: 0,
    onClick: () => setOpenId(id),
    onKeyDown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenId(id) } },
  })

  const seasonBar = (
    <div className="season-row">
      {seasons.map(sn => (
        <button key={sn} className={`chip ${season === sn ? 'on' : ''}`} onClick={() => setSeason(sn)}>
          {sn}{sn === currentSeason ? ' · in corso' : ''}
        </button>
      ))}
      <button className={`chip ${season === 'all' ? 'on' : ''}`} onClick={() => setSeason('all')}>Sempre</button>
    </div>
  )

  if (matches.length === 0) {
    return (
      <div className="stats-page">
        {seasonBar}
        <div className="empty-stats">
          {season === 'all' ? 'Nessuna partita ancora 🎮' : `Nessuna partita nella stagione ${season} 🎮`}
        </div>
      </div>
    )
  }

  const top3 = [...players].sort(cmpWins).filter(p => stats[p.id].wins > 0).slice(0, 3)
  const podiumOrder = top3.length >= 3
    ? [top3[1], top3[0], top3[2]]
    : top3.length === 2
      ? [top3[1], top3[0], null]
      : [null, top3[0] || null, null]
  const podiumClass = ['second', 'first', 'third']
  const podiumCrown = ['🥈', '🥇', '🥉']
  const podiumNum = ['2', '1', '3']

  const m = METRICS.find(x => x.key === metric)
  const ranked = [...players].sort((a, b) => (m.val(stats[b.id]) - m.val(stats[a.id])) || cmpWins(a, b))

  const TABS = [
    ['rank', 'Classifica'], ['chart', 'Grafico'], ['h2h', '1 vs 1'], ['nemesis', 'Nemesi'], ['history', 'Storico'],
  ]

  return (
    <div className="stats-page">
      {seasonBar}
      {top3.length > 0 && (
        <div className="podium">
          {podiumOrder.map((p, i) => p ? (
            <div key={p.id} className={`podium-place tappable ${podiumClass[i]}`} {...tap(p.id)}>
              <div className="podium-avatar-wrap">
                <span className="podium-crown">{podiumCrown[i]}</span>
                <Avatar participant={p} size={i === 1 ? 64 : 52} />
              </div>
              <span className="podium-name">{p.name.split(' ')[0]}</span>
              <span className="podium-pts">{stats[p.id].wins} vitt.</span>
              <div className="podium-block">{podiumNum[i]}</div>
            </div>
          ) : <div key={i} className={`podium-place ${podiumClass[i]}`} />)}
        </div>
      )}

      <div className="stats-tabs">
        {TABS.map(([k, label]) => (
          <button key={k} className={`stats-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'rank' && (
        <>
          <div className="metric-chips">
            {METRICS.map(x => (
              <button key={x.key} className={`chip ${metric === x.key ? 'on' : ''}`} onClick={() => setMetric(x.key)}>
                {x.label}
              </button>
            ))}
          </div>
          <div className="leaderboard">
            {ranked.map((p, i) => {
              const s = stats[p.id]
              const v = m.val(s)
              return (
                <div key={p.id} className="lb-row tappable" {...tap(p.id)}>
                  <span className={`lb-rank ${v < 0 ? '' : i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''}`}>{v < 0 ? '–' : i + 1}</span>
                  <Avatar participant={p} size={36} />
                  <div className="lb-main">
                    <span className="lb-name">{p.name}</span>
                    <span className="lb-sub">{s.wins} vinte · {s.draws} pari · {s.losses} perse</span>
                  </div>
                  <span className="lb-val">
                    {m.fmt(v)}
                    {m.unit && <span className="lb-val-label">{m.unit}</span>}
                  </span>
                </div>
              )
            })}
          </div>
          {metric === 'pct' && (
            <p className="chart-note">La % vittorie si calcola da {MIN_PCT_GAMES} partite giocate: prima di allora compare «—» e il giocatore resta in fondo.</p>
          )}
          {(metric === 'streak' || metric === 'best') && (
            <p className="chart-note">Una striscia conta le vittorie di fila nelle partite giocate. Un pareggio o una sconfitta la interrompono.</p>
          )}
        </>
      )}

      {tab === 'chart' && <ProgressChart players={players} stats={stats} ordered={ordered} cmpWins={cmpWins} />}
      {tab === 'h2h' && <HeadToHead players={players} ordered={ordered} />}
      {tab === 'nemesis' && <NemesisList players={players} stats={stats} ordered={ordered} cmpWins={cmpWins} tap={tap} />}

      {tab === 'history' && (
        <div className="match-list">
          {[...ordered].reverse().map(mt => {
            const ids = mt.kind === 'draw' ? mt.all : mt.winners
            const faces = ids.map(id => participants.find(p => p.id === id)).filter(Boolean)
            return (
              <div key={mt.id} className="match-card">
                {isAdmin && <button className="match-edit" onClick={() => setEditing(mt)}>✎ Modifica</button>}
                <div className="match-date">{formatDate(mt.date)}</div>
                <div className={`match-winner-label ${mt.kind === 'draw' ? 'draw' : mt.winnerTeam}`}>
                  {mt.kind === 'draw' ? '🤝 Pareggio' : `Squadra ${mt.winnerTeam.toUpperCase()} 🏆`}
                </div>
                <div className="match-faces">
                  {faces.map(p => (
                    <div key={p.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                      <Avatar participant={p} size={36} />
                      <span style={{ fontSize: 10, color: 'var(--text-muted)', maxWidth: 40, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {p.name.split(' ')[0]}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {editing && <MatchEditModal match={editing} matches={allMatches} onClose={() => setEditing(null)} />}

      {openId && stats[openId] && (
        <PlayerSheet
          player={byId[openId]}
          s={stats[openId]}
          rankPos={[...players].sort(cmpWins).findIndex(x => x.id === openId) + 1}
          ordered={ordered}
          byId={byId}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}

// ── Main App ───────────────────────────────────────────
export default function App() {
  const [participants, setParticipants] = useState([])
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState('home') // 'home' | 'stats'
  const [showModal, setShowModal] = useState(false)
  const [editingP, setEditingP] = useState(null)
  const [winTeam, setWinTeam] = useState(null) // 'a' | 'b'
  const [activeId, setActiveId] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [user, setUser] = useState(null)
  const [authMsg, setAuthMsg] = useState('')
  const [showLineup, setShowLineup] = useState(false)
  const [toast, setToast] = useState(null) // { label, prev: { id: team } }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } })
  )

  useEffect(() => {
    const unP = onSnapshot(
      query(collection(db, 'participants'), orderBy('position')),
      snap => { setParticipants(snap.docs.map(d => ({ id: d.id, ...d.data() }))); setLoading(false) }
    )
    const unM = onSnapshot(
      query(collection(db, 'matches'), orderBy('date', 'desc')),
      snap => setMatches(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    )
    return () => { unP(); unM() }
  }, [])

  useEffect(() => onAuthStateChanged(auth, u => setUser(u)), [])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 7000)
    return () => clearTimeout(t)
  }, [toast])

  const isAdmin = !!user && !!ADMIN_EMAIL && user.emailVerified && (user.email || '').toLowerCase() === ADMIN_EMAIL

  const visible = participants.filter(p => !p.hidden)
  const hidden = participants.filter(p => p.hidden)
  const pool = visible.filter(p => p.team === 'pool')
  const teamA = visible.filter(p => p.team === 'a')
  const teamB = visible.filter(p => p.team === 'b')
  const activeParticipant = participants.find(p => p.id === activeId)
  const lineup = useMemo(() => buildLineup(visible, matches, seasonOf(todayISO())), [participants, matches])

  async function signIn() {
    setAuthMsg('')
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (e) {
      const msg = {
        'auth/popup-blocked': 'Il browser ha bloccato la finestra di accesso: consentila e riprova.',
        'auth/unauthorized-domain': 'Dominio non autorizzato: aggiungilo in Firebase › Authentication › Impostazioni › Domini autorizzati.',
        'auth/operation-not-allowed': 'Accesso con Google non attivo: abilitalo in Firebase › Authentication › Metodo di accesso.',
      }[e.code]
      if (msg) setAuthMsg(msg)
      else if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') setAuthMsg('Accesso non riuscito, riprova.')
    }
  }

  // Sposta più giocatori in un colpo solo; si può annullare dal messaggio in basso
  function commitLayout(next, label) {
    const changed = visible.filter(p => p.team !== next[p.id])
    if (!changed.length) return
    const prev = {}
    changed.forEach(p => { prev[p.id] = p.team })
    setParticipants(list => list.map(p => (p.id in next ? { ...p, team: next[p.id] } : p)))
    const batch = writeBatch(db)
    changed.forEach(p => batch.update(doc(db, 'participants', p.id), { team: next[p.id] }))
    batch.commit().catch(() => {})
    setToast({ label, prev })
  }

  function applyLineup(A, B) {
    const next = {}
    visible.forEach(p => { next[p.id] = 'pool' })
    A.forEach(p => { next[p.id] = 'a' })
    B.forEach(p => { next[p.id] = 'b' })
    commitLayout(next, 'Squadre precompilate')
    setShowLineup(false)
  }

  function clearTeams() {
    const next = {}
    visible.forEach(p => { next[p.id] = 'pool' })
    commitLayout(next, 'Giocatori rimessi fuori dalle squadre')
  }

  function undoLayout() {
    if (!toast) return
    const { prev } = toast
    setParticipants(list => list.map(p => (p.id in prev ? { ...p, team: prev[p.id] } : p)))
    const batch = writeBatch(db)
    Object.entries(prev).forEach(([id, team]) => batch.update(doc(db, 'participants', id), { team }))
    batch.commit().catch(() => {})
    setToast(null)
  }

  async function moveToTeam(id, team) {
    setParticipants(prev => prev.map(p => p.id === id ? { ...p, team } : p))
    await updateDoc(doc(db, 'participants', id), { team })
  }

  function handleDragStart({ active }) { setActiveId(active.id) }
  function handleDragEnd({ active, over }) {
    setActiveId(null)
    if (!over) return
    const p = participants.find(x => x.id === active.id)
    if (!p || p.team === over.id) return
    moveToTeam(active.id, over.id)
  }

  async function handleHide(id) {
    setParticipants(prev => prev.map(p => p.id === id ? { ...p, hidden: true, team: 'pool' } : p))
    await updateDoc(doc(db, 'participants', id), { hidden: true, team: 'pool' })
  }

  async function handleRestore(id) {
    setParticipants(prev => prev.map(p => p.id === id ? { ...p, hidden: false } : p))
    await updateDoc(doc(db, 'participants', id), { hidden: false })
  }

  function handleSave(saved) {
    setParticipants(prev => {
      const exists = prev.find(p => p.id === saved.id)
      if (exists) return prev.map(p => p.id === saved.id ? saved : p)
      return [...prev, saved]
    })
    setShowModal(false); setEditingP(null)
  }

  async function handleWinConfirm(team, members, date) {
    const isDraw = team === 'draw'
    const allPlayers = [...teamA, ...teamB]
    if (matches.some(m => m.date === date)) throw new Error('duplicate')
    // L'ID del documento è la data: due salvataggi nello stesso giorno finiscono sullo stesso documento
    // e le regole di Firestore rifiutano il secondo (solo l'admin può modificare)
    try {
      await setDoc(doc(db, 'matches', date), {
        winnerTeam: team,
        winnerIds: isDraw ? [] : members.map(p => p.id),
        allIds: allPlayers.map(p => p.id),
        teamA: teamA.map(p => p.id),
        teamB: teamB.map(p => p.id),
        date,
        isDraw,
        created_at: serverTimestamp(),
      })
    } catch (e) {
      throw new Error(e.code === 'permission-denied' ? 'duplicate' : 'save')
    }
    setWinTeam(null)
  }

  if (loading) return <div className="loading">Caricamento…</div>

  return (
    <div className="app">
      <div className="header">
        <h1>{page === 'home' ? 'Squadre' : 'Statistiche'}</h1>
        {page === 'home' && (
          <div className="header-actions">
            <button className="add-btn" onClick={() => setEditMode(e => !e)}
              style={{ background: editMode ? '#ff4444' : undefined, color: editMode ? 'white' : undefined }}>
              {editMode ? '✓' : '✎'}
            </button>
            <button className="add-btn primary" onClick={() => setShowModal(true)}>+</button>
          </div>
        )}
        {page === 'stats' && (
          <div className="header-actions">
            <AccountButton user={user} isAdmin={isAdmin} onSignIn={signIn} onSignOut={() => signOut(auth)} />
          </div>
        )}
      </div>
      {page === 'stats' && authMsg && <p className="auth-note" onClick={() => setAuthMsg('')}>{authMsg}</p>}

      {page === 'home' && (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          {/* Pool */}
          <div className="pool-section">
            <p className="pool-title">In attesa ({pool.length})</p>
            <DroppablePool>
              {pool.map(p => (
                <ParticipantCard key={p.id} participant={p} inTeam={false}
                  showActions={editMode} onHide={handleHide} onEdit={setEditingP} />
              ))}
            </DroppablePool>
          </div>

          {/* Hidden players */}
          {hidden.length > 0 && (
            <div className="hidden-section">
              <button className="hidden-toggle" onClick={() => setShowHidden(s => !s)}>
                👻 Nascosti ({hidden.length}) {showHidden ? '▲' : '▼'}
              </button>
              {showHidden && (
                <div className="hidden-list">
                  {hidden.map(p => (
                    <div key={p.id} className="hidden-card">
                      <Avatar participant={p} size={52} />
                      <span className="participant-name">{p.name.split(' ')[0]}</span>
                      <button className="restore-btn" onClick={() => handleRestore(p.id)}>+</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Teams */}
          <div className="team-tools">
            <button className="tool-btn" onClick={() => setShowLineup(true)} disabled={visible.length < 2}>✨ Precompila</button>
            <button className="tool-btn" onClick={clearTeams} disabled={teamA.length + teamB.length === 0}>↺ Svuota squadre</button>
          </div>
          <div className="zone-labels">
            <div className="zone-badge a">⚽ Squadra A</div>
            <div className="zone-badge b">⚽ Squadra B</div>
          </div>
          <div className="teams">
            <DroppableTeam team="a" members={teamA} count={teamA.length}
              showActions={editMode} onHide={handleHide} onEdit={setEditingP}
              onWin={t => setWinTeam(t)} />
            <DroppableTeam team="b" members={teamB} count={teamB.length}
              showActions={editMode} onHide={handleHide} onEdit={setEditingP}
              onWin={t => setWinTeam(t)} />
          </div>
          {(teamA.length > 0 || teamB.length > 0) && (
            <div style={{ padding: '0 20px 16px' }}>
              <button className="draw-btn" onClick={() => setWinTeam('draw')}>
                🤝 Pareggio
              </button>
            </div>
          )}

          <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
            {activeParticipant && (
              <div className="participant overlay">
                <Avatar participant={activeParticipant} size={60} />
                <span className="participant-name">{activeParticipant.name}</span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      )}

      {page === 'stats' && (
        <StatsPage participants={participants} matches={matches} isAdmin={isAdmin} />
      )}

      {/* Bottom nav */}
      <nav className="bottom-nav">
        <button className={`nav-btn ${page === 'home' ? 'active' : ''}`} onClick={() => setPage('home')}>
          ⚽<span>Squadre</span>
        </button>
        <button className={`nav-btn ${page === 'stats' ? 'active' : ''}`} onClick={() => setPage('stats')}>
          🏆<span>Statistiche</span>
        </button>
      </nav>

      {/* Modals */}
      {showModal && <ParticipantModal onClose={() => setShowModal(false)} onSave={handleSave} />}
      {editingP && <ParticipantModal existing={editingP} onClose={() => setEditingP(null)} onSave={handleSave} />}
      {showLineup && (
        <LineupSheet lineup={lineup} season={seasonOf(todayISO())} onApply={applyLineup} onClose={() => setShowLineup(false)} />
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.label}</span>
          <button onClick={undoLayout}>Annulla</button>
        </div>
      )}
      {winTeam && (
        <WinModal
          team={winTeam}
          teamA={teamA}
          teamB={teamB}
          matches={matches}
          onClose={() => setWinTeam(null)}
          onConfirm={handleWinConfirm}
        />
      )}
    </div>
  )
}
