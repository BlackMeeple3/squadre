import { useState, useEffect, useRef } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core'
import { supabase } from './lib/supabase'
import './index.css'

function initials(name) {
  return name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function Avatar({ participant, size = 'md' }) {
  const sz = size === 'sm' ? 44 : 64
  return (
    <div className="avatar" style={{ width: sz, height: sz }}>
      {participant.photo_url ? (
        <img src={participant.photo_url} alt={participant.name} />
      ) : (
        <div className="avatar-initials" style={{ fontSize: size === 'sm' ? 15 : 20 }}>
          {initials(participant.name)}
        </div>
      )}
    </div>
  )
}

function ParticipantCard({ participant, inTeam, onDelete, onEdit, showDelete }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: participant.id,
  })

  return (
    <div
      ref={setNodeRef}
      className={`participant ${isDragging ? 'dragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      <Avatar participant={participant} size={inTeam ? 'sm' : 'md'} />
      <span className="participant-name">{participant.name}</span>
      {showDelete && (
        <>
          <button
            className="del-btn edit-btn"
            onPointerDown={e => { e.stopPropagation(); onEdit(participant) }}
            aria-label="Modifica"
          >
            ✎
          </button>
          <button
            className="del-btn"
            onPointerDown={e => { e.stopPropagation(); onDelete(participant.id) }}
            aria-label="Elimina"
          >
            ×
          </button>
        </>
      )}
    </div>
  )
}

function DroppablePool({ children }) {
  const { setNodeRef, isOver } = useDroppable({ id: 'pool' })
  return (
    <div ref={setNodeRef} className={`pool-scroll ${isOver ? 'drag-over' : ''}`}>
      {children}
    </div>
  )
}

function DroppableTeam({ team, children, count }) {
  const { setNodeRef, isOver } = useDroppable({ id: team })
  return (
    <div ref={setNodeRef} className={`team-col ${team} ${isOver ? 'drag-over' : ''}`}>
      <span className="team-count">{count}</span>
      <div className="team-members">
        {children.length === 0 ? (
          <div className="empty-drop">
            <span>Trascina qui</span>
          </div>
        ) : children}
      </div>
    </div>
  )
}

function ParticipantModal({ existing, onClose, onSave }) {
  const [name, setName] = useState(existing?.name || '')
  const [photoFile, setPhotoFile] = useState(null)
  const [photoPreview, setPhotoPreview] = useState(existing?.photo_url || null)
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef()

  const isEdit = !!existing

  const handlePhoto = e => {
    const file = e.target.files[0]
    if (!file) return
    setPhotoFile(file)
    setPhotoPreview(URL.createObjectURL(file))
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setUploading(true)
    try {
      let photo_url = existing?.photo_url || null

      if (photoFile) {
        const ext = photoFile.name.split('.').pop()
        const path = `${Date.now()}.${ext}`
        const { error: upErr } = await supabase.storage
          .from('photos')
          .upload(path, photoFile, { upsert: true })
        if (!upErr) {
          const { data } = supabase.storage.from('photos').getPublicUrl(path)
          photo_url = data.publicUrl
        }
      }

      if (isEdit) {
        const { data, error } = await supabase
          .from('participants')
          .update({ name: name.trim(), photo_url })
          .eq('id', existing.id)
          .select()
          .single()
        if (!error) onSave(data)
      } else {
        const { data, error } = await supabase
          .from('participants')
          .insert({ name: name.trim(), photo_url, team: 'pool', position: Date.now() })
          .select()
          .single()
        if (!error) onSave(data)
      }
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="modal-overlay" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <h2>{isEdit ? 'Modifica' : 'Nuovo partecipante'}</h2>

        <div className="photo-picker" onClick={() => fileRef.current.click()}>
          {photoPreview ? (
            <img src={photoPreview} alt="preview" />
          ) : (
            <>
              <span className="photo-icon">📷</span>
              <span className="photo-picker-label">Aggiungi foto</span>
            </>
          )}
          {uploading && (
            <div className="uploading-indicator">
              <div className="spinner" />
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handlePhoto}
        />

        <div className="field">
          <label>Nome</label>
          <input
            type="text"
            placeholder="Es. Marco Rossi"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSave()}
            autoFocus
          />
        </div>

        <div className="modal-actions">
          <button className="btn-cancel" onClick={onClose}>Annulla</button>
          <button
            className="btn-save"
            onClick={handleSave}
            disabled={!name.trim() || uploading}
          >
            {uploading ? 'Salvataggio…' : isEdit ? 'Salva' : 'Aggiungi'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [participants, setParticipants] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editingParticipant, setEditingParticipant] = useState(null)
  const [activeId, setActiveId] = useState(null)
  const [editMode, setEditMode] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 120, tolerance: 8 },
    })
  )

  useEffect(() => {
    loadParticipants()

    const channel = supabase
      .channel('participants-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants' }, () => {
        loadParticipants()
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [])

  async function loadParticipants() {
    const { data } = await supabase
      .from('participants')
      .select('*')
      .order('position')
    if (data) setParticipants(data)
    setLoading(false)
  }

  const pool = participants.filter(p => p.team === 'pool')
  const teamA = participants.filter(p => p.team === 'a')
  const teamB = participants.filter(p => p.team === 'b')
  const activeParticipant = participants.find(p => p.id === activeId)

  async function moveToTeam(participantId, team) {
    setParticipants(prev =>
      prev.map(p => p.id === participantId ? { ...p, team } : p)
    )
    await supabase
      .from('participants')
      .update({ team })
      .eq('id', participantId)
  }

  function handleDragStart({ active }) {
    setActiveId(active.id)
  }

  function handleDragEnd({ active, over }) {
    setActiveId(null)
    if (!over) return
    const dest = over.id
    const participant = participants.find(p => p.id === active.id)
    if (!participant || participant.team === dest) return
    moveToTeam(active.id, dest)
  }

  function handleSave(savedParticipant) {
    setParticipants(prev => {
      const exists = prev.find(p => p.id === savedParticipant.id)
      if (exists) return prev.map(p => p.id === savedParticipant.id ? savedParticipant : p)
      return [...prev, savedParticipant]
    })
    setShowModal(false)
    setEditingParticipant(null)
  }

  async function handleDelete(id) {
    setParticipants(prev => prev.filter(p => p.id !== id))
    await supabase.from('participants').delete().eq('id', id)
  }

  if (loading) return <div className="loading">Caricamento…</div>

  return (
    <div className="app">
      <div className="header">
        <h1>Squadre</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            className="add-btn"
            onClick={() => setEditMode(e => !e)}
            style={{
              background: editMode ? '#ff4444' : 'var(--surface2)',
              color: editMode ? 'white' : 'var(--text-muted)',
              fontSize: 16,
            }}
            title={editMode ? 'Fine modifica' : 'Modifica/elimina'}
          >
            {editMode ? '✓' : '✎'}
          </button>
          <button className="add-btn" onClick={() => setShowModal(true)} title="Aggiungi partecipante">
            +
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="pool-section">
          <p className="pool-title">In attesa ({pool.length})</p>
          <DroppablePool>
            {pool.map(p => (
              <ParticipantCard
                key={p.id}
                participant={p}
                inTeam={false}
                showDelete={editMode}
                onDelete={handleDelete}
                onEdit={p => setEditingParticipant(p)}
              />
            ))}
            {pool.length === 0 && (
              <div className="empty-drop">
                <span>Nessuno in attesa</span>
              </div>
            )}
          </DroppablePool>
        </div>

        <div className="zone-labels">
          <div className="zone-badge a">⚽ Squadra A</div>
          <div className="zone-badge b">⚽ Squadra B</div>
        </div>

        <div className="teams">
          <DroppableTeam team="a" count={teamA.length}>
            {teamA.map(p => (
              <ParticipantCard
                key={p.id}
                participant={p}
                inTeam={true}
                showDelete={editMode}
                onDelete={handleDelete}
                onEdit={p => setEditingParticipant(p)}
              />
            ))}
          </DroppableTeam>
          <DroppableTeam team="b" count={teamB.length}>
            {teamB.map(p => (
              <ParticipantCard
                key={p.id}
                participant={p}
                inTeam={true}
                showDelete={editMode}
                onDelete={handleDelete}
                onEdit={p => setEditingParticipant(p)}
              />
            ))}
          </DroppableTeam>
        </div>

        <DragOverlay dropAnimation={{
          duration: 200,
          easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
        }}>
          {activeParticipant && (
            <div className="participant overlay">
              <Avatar participant={activeParticipant} size="md" />
              <span className="participant-name">{activeParticipant.name}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {showModal && (
        <ParticipantModal
          onClose={() => setShowModal(false)}
          onSave={handleSave}
        />
      )}

      {editingParticipant && (
        <ParticipantModal
          existing={editingParticipant}
          onClose={() => setEditingParticipant(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
