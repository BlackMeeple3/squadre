import { useState, useEffect, useRef } from 'react'
import {
  DndContext, DragOverlay,
  PointerSensor, TouchSensor,
  useSensor, useSensors,
  useDroppable, useDraggable,
} from '@dnd-kit/core'
import {
  collection, addDoc, updateDoc, deleteDoc,
  doc, onSnapshot, orderBy, query, serverTimestamp,
} from 'firebase/firestore'
import { db } from './lib/firebase'
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
  const d = new Date(iso)
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })
}

function todayISO() {
  return new Date().toISOString().split('T')[0]
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
function WinModal({ team, teamA, teamB, onClose, onConfirm }) {
  const [date, setDate] = useState(todayISO())
  const [saving, setSaving] = useState(false)
  const isDraw = team === 'draw'
  const members = isDraw ? [...teamA, ...teamB] : (team === 'a' ? teamA : teamB)

  const handle = async () => {
    setSaving(true)
    await onConfirm(team, members, date)
    setSaving(false)
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

        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button
            className={`btn-save ${isDraw ? '' : team === 'a' ? 'btn-win-a' : 'btn-win-b'}`}
            onClick={handle} disabled={saving}
          >
            {saving ? 'Salvataggio…' : isDraw ? 'Conferma pareggio' : 'Conferma vittoria'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Stats Page ─────────────────────────────────────────
function StatsPage({ participants, matches }) {
  const [tab, setTab] = useState('wins')

  const sorted = [...participants].sort((a, b) => (b.wins || 0) - (a.wins || 0))
  const sortedMatches = [...participants].sort((a, b) => (b.matches || 0) - (a.matches || 0))
  const top3 = sorted.slice(0, 3)

  const podiumOrder = top3.length >= 3
    ? [top3[1], top3[0], top3[2]]
    : top3.length === 2
      ? [null, top3[0], top3[1]]
      : [null, top3[0], null]

  const podiumClass = ['second', 'first', 'third']
  const podiumCrown = ['🥈', '🥇', '🥉']

  return (
    <div className="stats-page">
      {/* Podium */}
      {top3.length > 0 ? (
        <div className="podium">
          {podiumOrder.map((p, i) => p ? (
            <div key={p.id} className={`podium-place ${podiumClass[i]}`}>
              <div className="podium-avatar-wrap">
                <span className="podium-crown">{podiumCrown[i]}</span>
                <Avatar participant={p} size={i === 1 ? 64 : 52} />
              </div>
              <span className="podium-name">{p.name.split(' ')[0]}</span>
              <span className="podium-pts">{p.wins || 0} vitt.</span>
              <div className="podium-block">{i === 1 ? '1' : i === 0 ? '2' : '3'}</div>
            </div>
          ) : <div key={i} className={`podium-place ${podiumClass[i]}`} />)}
        </div>
      ) : (
        <div className="empty-stats">Nessuna partita ancora 🎮</div>
      )}

      {/* Tabs */}
      <div className="stats-tabs">
        <button className={`stats-tab ${tab === 'wins' ? 'active' : ''}`} onClick={() => setTab('wins')}>Vittorie</button>
        <button className={`stats-tab ${tab === 'matches' ? 'active' : ''}`} onClick={() => setTab('matches')}>Presenze</button>
        <button className={`stats-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>Storico</button>
      </div>

      {/* Vittorie */}
      {tab === 'wins' && (
        <div className="leaderboard">
          {sorted.filter(p => !p.hidden).map((p, i) => (
            <div key={p.id} className="lb-row">
              <span className={`lb-rank ${i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''}`}>{i + 1}</span>
              <Avatar participant={p} size={36} />
              <span className="lb-name">{p.name}</span>
              <span className="lb-val">{p.wins || 0}<span className="lb-val-label">V</span></span>
            </div>
          ))}
        </div>
      )}

      {/* Presenze */}
      {tab === 'matches' && (
        <div className="leaderboard">
          {sortedMatches.filter(p => !p.hidden).map((p, i) => (
            <div key={p.id} className="lb-row">
              <span className={`lb-rank ${i === 0 ? 'r1' : i === 1 ? 'r2' : i === 2 ? 'r3' : ''}`}>{i + 1}</span>
              <Avatar participant={p} size={36} />
              <span className="lb-name">{p.name}</span>
              <span className="lb-val">{p.matches || 0}<span className="lb-val-label">P</span></span>
            </div>
          ))}
        </div>
      )}

      {/* Storico */}
      {tab === 'history' && (
        <div className="match-list">
          {matches.length === 0 && <div className="empty-stats">Nessuna partita ancora 🎮</div>}
          {[...matches].sort((a, b) => new Date(b.date) - new Date(a.date)).map(m => {
            return (
              <div key={m.id} className="match-card">
                <div className="match-date">{formatDate(m.date)}</div>
                <div className={`match-winner-label ${m.isDraw ? 'draw' : m.winnerTeam}`}>
                  {m.isDraw ? '🤝 Pareggio' : `Squadra ${m.winnerTeam.toUpperCase()} 🏆`}
                </div>
                <div className="match-faces">
                  {(m.isDraw ? m.allIds || [] : m.winnerIds || []).map(id => participants.find(p => p.id === id)).filter(Boolean).map(p => (
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

  const visible = participants.filter(p => !p.hidden)
  const hidden = participants.filter(p => p.hidden)
  const pool = visible.filter(p => p.team === 'pool')
  const teamA = visible.filter(p => p.team === 'a')
  const teamB = visible.filter(p => p.team === 'b')
  const activeParticipant = participants.find(p => p.id === activeId)

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
    // Save match
    await addDoc(collection(db, 'matches'), {
      winnerTeam: team,
      winnerIds: isDraw ? [] : members.map(p => p.id),
      allIds: allPlayers.map(p => p.id),
      date,
      isDraw,
      created_at: serverTimestamp(),
    })
    // Update stats: draw = +1 presence only; win = +1 win +1 presence for winners, +1 presence for losers
    for (const p of allPlayers) {
      const isWinner = !isDraw && members.some(m => m.id === p.id)
      await updateDoc(doc(db, 'participants', p.id), {
        wins: (p.wins || 0) + (isWinner ? 1 : 0),
        matches: (p.matches || 0) + 1,
      })
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
      </div>

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
        <StatsPage participants={participants.filter(p => !p.hidden)} matches={matches} />
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
      {winTeam && (
        <WinModal
          team={winTeam}
          teamA={teamA}
          teamB={teamB}
          onClose={() => setWinTeam(null)}
          onConfirm={handleWinConfirm}
        />
      )}
    </div>
  )
}